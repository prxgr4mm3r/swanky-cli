import { Args, Flags } from "@oclif/core";
import path from "node:path";
import { ensureDir, writeJSON, pathExists, copy, outputFile, readJSON, remove } from "fs-extra/esm";
import { stat, readdir, readFile } from "fs/promises";
import { execaCommand, execaCommandSync } from "execa";
import { paramCase, pascalCase, snakeCase } from "change-case";
import inquirer from "inquirer";
import TOML from "@iarna/toml";
import { choice, email, name, pickTemplate } from "../../lib/prompts.js";
import {
  checkCliDependencies,
  copyCommonTemplateFiles,
  copyContractTemplateFiles,
  downloadNode,
  installDeps,
  ChainAccount,
  processTemplates,
  swankyNode,
  getTemplates,
} from "../../lib/index.js";
import {
  DEFAULT_ASTAR_NETWORK_URL,
  DEFAULT_NETWORK_URL,
  DEFAULT_SHIBUYA_NETWORK_URL,
  DEFAULT_SHIDEN_NETWORK_URL,
} from "../../lib/consts.js";
import { SwankyCommand } from "../../lib/swankyCommand.js";
import { InputError, UnknownError } from "../../lib/errors.js";
import { GlobEntry, globby } from "globby";
import { merge } from "lodash-es";
import inquirerFuzzyPath from "inquirer-fuzzy-path";
import { SwankyConfig } from "../../types/index.js";
import chalk from "chalk";

type TaskFunction = (...args: any[]) => any;

interface Task {
  task: TaskFunction;
  args: any[];
  runningMessage: string;
  successMessage?: string;
  failMessage?: string;
  shouldExitOnError?: boolean;
  callback?: (param: string) => void;
}

interface PathEntry {
  dirent: GlobEntry["dirent"];
  name: string;
  path: string;
  moduleName?: string;
}

interface CopyCandidates {
  contracts: PathEntry[];
  crates: PathEntry[];
  tests?: PathEntry[];
}

interface CopyPathsList {
  contractsDirectories: string[];
  cratesDirectories: string[];
}

inquirer.registerPrompt("fuzzypath", inquirerFuzzyPath);

export class Init extends SwankyCommand<typeof Init> {
  static description = "Generate a new smart contract environment";

  static flags = {
    "swanky-node": Flags.boolean(),
    template: Flags.string({
      options: getTemplates().contractTemplatesList,
      char: "t",
    }),
    convert: Flags.string({
      char: "c",
      description: "Converts an existing smart contract into a Swanky project",
    }),
  };

  static args = {
    projectName: Args.string({
      name: "projectName",
      required: true,
      description: "directory name of new project",
    }),
  };

  constructor(argv: string[], config: any) {
    super(argv, config);
    (this.constructor as typeof SwankyCommand).ENSURE_SWANKY_CONFIG = false;
  }
  projectPath = "";

  configBuilder: Partial<SwankyConfig> = {
    node: {
      localPath: "",
      polkadotPalletVersions: swankyNode.polkadotPalletVersions,
      supportedInk: swankyNode.supportedInk,
    },
    accounts: [],
    networks: {
      local: { url: DEFAULT_NETWORK_URL },
      astar: { url: DEFAULT_ASTAR_NETWORK_URL },
      shiden: { url: DEFAULT_SHIDEN_NETWORK_URL },
      shibuya: { url: DEFAULT_SHIBUYA_NETWORK_URL },
    },
    contracts: {},
  };

  taskQueue: Task[] = [];

  async run(): Promise<void> {
    const { args, flags } = await this.parse(Init);

    this.projectPath = path.resolve(args.projectName);

    // check if projectPath dir exists and is it empty
    try {
      const pathStat = await stat(this.projectPath);
      if (pathStat.isDirectory()) {
        const files = await readdir(this.projectPath);
        if (files.length > 0)
          throw new InputError(`Directory ${chalk.yellowBright(args.projectName)} is not empty!`);
      }
    } catch (error: unknown) {
      // ignore if it doesn't exist, it will be created
      if (!(error instanceof Error) || !error.message.includes("ENOENT"))
        throw new UnknownError("Unexpected error", { cause: error });
    }

    const templates = getTemplates();
    this.taskQueue.push({
      task: copyCommonTemplateFiles,
      args: [templates.templatesPath, this.projectPath],
      runningMessage: "Copying common template files",
    });

    if (flags.convert) {
      await this.convert(flags.convert, args.projectName);
    } else {
      await this.generate(args.projectName);
    }

    this.taskQueue.push({
      task: installDeps,
      args: [this.projectPath],
      runningMessage: "Installing dependencies",
      shouldExitOnError: false,
    });

    this.taskQueue.push({
      task: execaCommand,
      args: ["git init", { cwd: this.projectPath }],
      runningMessage: "Initializing git",
    });

    if (!flags["swanky-node"]) {
      const { useSwankyNode } = await inquirer.prompt([
        choice("useSwankyNode", "Do you want to download Swanky node?"),
      ]);
      if (useSwankyNode) {
        this.taskQueue.push({
          task: downloadNode,
          args: [this.projectPath, swankyNode, this.spinner],
          runningMessage: "Downloading Swanky node",
          callback: (result) =>
            this.configBuilder.node ? (this.configBuilder.node.localPath = result) : null,
        });
      }
    }

    this.configBuilder.accounts = [
      {
        alias: "alice",
        mnemonic: "//Alice",
        isDev: true,
        address: new ChainAccount("//Alice").pair.address,
      },
      {
        alias: "bob",
        mnemonic: "//Bob",
        isDev: true,
        address: new ChainAccount("//Bob").pair.address,
      },
    ];

    Object.keys(this.configBuilder.contracts!).forEach(async (contractName) => {
      await ensureDir(path.resolve(this.projectPath, "artifacts", contractName));
      await ensureDir(path.resolve(this.projectPath, "tests", contractName));
    });

    this.taskQueue.push({
      task: () =>
        writeJSON(path.resolve(this.projectPath, "swanky.config.json"), this.configBuilder, {
          spaces: 2,
        }),
      args: [],
      runningMessage: "Writing config",
    });

    for (const {
      task,
      args,
      runningMessage,
      successMessage,
      failMessage,
      shouldExitOnError,
      callback,
    } of this.taskQueue) {
      const result = await this.spinner.runCommand(
        () => task(...args),
        runningMessage,
        successMessage,
        failMessage,
        shouldExitOnError
      );
      if (result && callback) {
        callback(result as string);
      }
    }
    this.log("🎉 😎 Swanky project successfully initialised! 😎 🎉");
  }

  async generate(projectName: string) {
    const templates = getTemplates();

    let gitUser;

    try {
      const detectedGitUser = execaCommandSync("git config --get user.name").stdout;
      gitUser = detectedGitUser;
    } catch (_) {
      gitUser = undefined;
    }

    const {
      contractTemplate,
      contractName,
      authorName,
      email: authorEmail,
    } = await inquirer.prompt([
      pickTemplate(templates.contractTemplatesList),
      name("contract", (ans) => ans.contractTemplate, "What should we name your initial contract?"),
      {
        name: "authorName",
        type: "input",
        message: "What is your name?",
        default: gitUser,
        validate: (answer) => answer && answer.length > 0,
      },
      email(),
    ]);

    this.taskQueue.push({
      task: checkCliDependencies,
      args: [this.spinner],
      runningMessage: "Checking dependencies",
    });

    this.taskQueue.push({
      task: copyContractTemplateFiles,
      args: [
        path.resolve(templates.contractTemplatesPath, contractTemplate),
        contractName,
        this.projectPath,
      ],
      runningMessage: "Copying contract template files",
    });

    this.taskQueue.push({
      task: processTemplates,
      args: [
        this.projectPath,
        {
          project_name: paramCase(projectName),
          author_name: authorName,
          author_email: authorEmail,
          swanky_version: this.config.pjson.version,
          contract_name: contractName,
          contract_name_snake: snakeCase(contractName),
          contract_name_pascal: pascalCase(contractName),
        },
      ],
      runningMessage: "Processing templates",
    });

    this.configBuilder.contracts = {
      [contractName as string]: {
        name: contractName,
        moduleName: snakeCase(contractName),
        deployments: [],
      },
    };
  }

  async convert(pathToExistingProject: string, projectName: string) {
    try {
      const pathStat = await stat(pathToExistingProject);
      if (pathStat.isDirectory()) {
        const files = await readdir(pathToExistingProject);
        if (files.length < 1)
          throw new InputError(`Target project directory [${pathToExistingProject}] is empty!`);
      }
    } catch (cause) {
      throw new InputError(
        `Error reading target directory [${chalk.yellowBright(pathToExistingProject)}]`,
        { cause }
      );
    }

    const copyGlobsList: CopyPathsList = {
      contractsDirectories: await getManualPaths(pathToExistingProject, "contracts"),
      cratesDirectories: [],
    };

    const { shouldSpecifyCratesDir } = await inquirer.prompt([
      choice("shouldSpecifyCratesDir", "Do you want to specify an additional crates directory?"),
    ]);

    if (shouldSpecifyCratesDir) {
      const manualCratesPath = await getManualPaths(pathToExistingProject, "crates");
      copyGlobsList.cratesDirectories.push(...manualCratesPath);
    }

    const candidatesList: CopyCandidates = await getCopyCandidatesList(
      pathToExistingProject,
      copyGlobsList
    );

    const testDir = await detectTests(pathToExistingProject);

    candidatesList.tests =
      testDir && (await pathExists(testDir))
        ? await getDirsAndFiles(pathToExistingProject, [testDir])
        : [];

    const confirmedCopyList = await detectModuleNames(await confirmCopyList(candidatesList));

    this.taskQueue.push({
      task: processTemplates,
      args: [
        this.projectPath,
        {
          project_name: paramCase(projectName),
          swanky_version: this.config.pjson.version,
        },
      ],
      runningMessage: "Processing templates",
    });

    this.taskQueue.push({
      task: copyWorkspaceContracts,
      args: [confirmedCopyList, this.projectPath],
      runningMessage: "Copying existing project files",
      successMessage: "Project files successfully copied",
      failMessage: "Failed to copy project files",
      shouldExitOnError: true,
      callback: (result) => {
        console.log(result);
      },
    });

    if (!this.configBuilder.contracts) this.configBuilder.contracts = {};

    for (const contract of confirmedCopyList.contracts) {
      this.configBuilder.contracts[contract.name] = {
        name: contract.name,
        moduleName: contract.moduleName!,
        deployments: [],
      };
    }

    let rootToml = await readRootCargoToml(pathToExistingProject);

    if (!rootToml) rootToml = { workspace: {} };

    rootToml.workspace.members = ["contracts/*"];

    this.taskQueue.push({
      task: async (tomlObject, projectPath) => {
        const tomlString = TOML.stringify(tomlObject);
        const rootTomlPath = path.resolve(projectPath, "Cargo.toml");
        await outputFile(rootTomlPath, tomlString);
      },
      args: [rootToml, this.projectPath],
      runningMessage: "Writing Cargo.toml",
    });

    this.taskQueue.push({
      task: async (pathToExistingProject, projectPath) => {
        const fileList = ["rust-toolchain.toml", ".rustfmt.toml"];
        for (const fileName of fileList) {
          const filePath = path.resolve(pathToExistingProject, fileName);
          if (await pathExists(filePath)) {
            await copy(filePath, path.resolve(projectPath, fileName));
          }
        }
      },
      args: [pathToExistingProject, this.projectPath],
      runningMessage: "Copying workspace files",
    });

    const existingPJsonPath = path.resolve(pathToExistingProject, "package.json");
    if (await pathExists(existingPJsonPath)) {
      this.taskQueue.push({
        task: async (pJsonPath, projectPath) => {
          const existingPJson = await readJSON(pJsonPath);
          const templatePJsonPath = path.resolve(projectPath, "package.json");
          const templatePJson = await readJSON(templatePJsonPath);
          const mergedJson = merge(templatePJson, existingPJson);
          await remove(templatePJsonPath);
          await writeJSON(templatePJsonPath, mergedJson, { spaces: 2 });
        },
        args: [existingPJsonPath, this.projectPath],
        runningMessage: "Merging package.json",
      });
    }
  }
}

async function detectModuleNames(copyList: CopyCandidates): Promise<CopyCandidates> {
  const copyListWithModuleNames: CopyCandidates = {
    contracts: [],
    crates: [],
    tests: copyList.tests ? [...copyList.tests] : [],
  };

  for (const group of ["contracts", "crates"]) {
    for (const entry of copyList[group as keyof CopyCandidates]!) {
      const moduleName = path.basename(entry.path);
      const extendedEntry = { ...entry, moduleName };
      if (
        entry.dirent.isDirectory() &&
        (await pathExists(path.resolve(entry.path, "Cargo.toml")))
      ) {
        const fileData = await readFile(path.resolve(entry.path, "Cargo.toml"), "utf-8");
        const toml: any = TOML.parse(fileData);
        if (toml.package?.name) {
          extendedEntry.moduleName = toml.package.name;
        } else {
          console.log(`Could not detect the contract name from Cargo.toml. Using [${moduleName}]`);
        }
      }
      copyListWithModuleNames[group as "contracts" | "crates"].push(extendedEntry);
    }
  }
  return copyListWithModuleNames;
}

async function copyWorkspaceContracts(copyList: CopyCandidates, projectPath: string) {
  for (const group of ["contracts", "crates", "tests"]) {
    const destDir = path.resolve(projectPath, group);
    await ensureDir(destDir);
    for (const entry of copyList[group as keyof CopyCandidates]!) {
      const destPath = path.join(destDir, entry.name);
      await copy(entry.path, destPath);
    }
  }
}

async function confirmCopyList(candidatesList: CopyCandidates) {
  if (!candidatesList.tests) candidatesList.tests = [];

  const { confirmedCopyList } = await inquirer.prompt({
    message: "Please review the list of files and directories to copy:",
    name: "confirmedCopyList",
    type: "checkbox",
    choices: [
      new inquirer.Separator("=====Contracts====="),
      ...candidatesList.contracts.map((contract) => ({
        name: `${contract.name}${contract.dirent.isDirectory() ? "/" : ""}`,
        value: { ...contract, group: "contracts" },
        checked: true,
      })),
      new inquirer.Separator("=====Crates====="),
      ...candidatesList.crates.map((path) => ({
        name: `${path.name}${path.dirent.isDirectory() ? "/" : ""}`,
        value: { ...path, group: "crates" },
        checked: true,
      })),
      new inquirer.Separator("=====Tests====="),
      ...candidatesList.tests.map((test) => ({
        name: `${test.name}${test.dirent.isDirectory() ? "/" : ""}`,
        value: { ...test, group: "tests" },
        checked: true,
      })),
    ],
  });

  const resultingList: CopyCandidates = { contracts: [], crates: [], tests: [] };
  confirmedCopyList.forEach(
    (
      item: PathEntry & {
        group: "contracts" | "crates" | "tests";
      }
    ) => {
      resultingList[item.group]?.push(item);
    }
  );
  return resultingList;
}

async function detectTests(pathToExistingProject: string): Promise<string | undefined> {
  const testDirNames = ["test", "tests", "spec", "specs"];

  let testDir: string | undefined = undefined;

  for (const testDirName of testDirNames) {
    const testDirCandidate = path.resolve(pathToExistingProject, testDirName);
    const testDirExists = await pathExists(testDirCandidate);
    if (testDirExists) {
      testDir = testDirCandidate;
      break;
    }
  }

  const testDirDetected = Boolean(testDir);

  const { shouldInputTestDir } = await inquirer.prompt([
    {
      when: () => testDirDetected,
      type: "confirm",
      name: "shouldUseDetectedTestDir",
      message: `Detected test directory [${path.basename(
        testDir!
      )}]. Do you want to copy it to your new project?`,
      default: true,
    },
    {
      when: (answers) => (testDirDetected && !answers.shouldUseDetectedTestDir) || !testDirDetected,
      name: "shouldInputTestDir",
      type: "confirm",
      message: "Do you want to specify a test directory to copy?",
      default: false,
    },
  ]);
  if (shouldInputTestDir) {
    const manualTestDir = await getManualPaths(pathToExistingProject, "tests");
    return manualTestDir[0];
  }
  return testDir;
}

async function readRootCargoToml(pathToProject: string) {
  const rootTomlPath = path.resolve(pathToProject, "Cargo.toml");
  if (!(await pathExists(rootTomlPath))) return null;
  const fileData = await readFile(rootTomlPath, "utf-8");
  const toml: any = TOML.parse(fileData);

  if (!toml.workspace) toml.workspace = {};

  return toml;
}

async function getManualPaths(
  pathToProject: string,
  directoryType: "contracts" | "crates" | "tests",
  paths: string[] = []
): Promise<string[]> {
  const { selectedDirectory } = await inquirer.prompt([
    {
      type: "fuzzypath",
      name: "selectedDirectory",
      itemType: "directory",
      rootPath: pathToProject,
      message: `Please enter a path to your ${directoryType} directory:`,
      excludePath: (nodePath: string) =>
        nodePath.includes("node_modules") ||
        nodePath.includes(".git") ||
        nodePath.includes("target"),
    },
  ]);

  if (directoryType !== "tests") {
    const { hasMorePaths } = await inquirer.prompt([
      {
        type: "confirm",
        name: "hasMorePaths",
        message: `Do you want to add more paths to ${directoryType}?`,
        default: false,
      },
    ]);

    if (hasMorePaths) {
      return getManualPaths(pathToProject, directoryType, [...paths, selectedDirectory]);
    }
  }
  return [...paths, selectedDirectory];
}

async function getCopyCandidatesList(
  projectPath: string,
  pathsToCopy: {
    contractsDirectories: string[];
    cratesDirectories: string[];
  }
) {
  const detectedPaths = {
    contracts: await getDirsAndFiles(projectPath, pathsToCopy.contractsDirectories),
    crates:
      pathsToCopy.cratesDirectories.length > 0
        ? await getDirsAndFiles(projectPath, pathsToCopy.cratesDirectories)
        : [],
  };

  return detectedPaths;
}

async function getGlobPaths(projectPath: string, globList: string[], isDirOnly: boolean) {
  return globby(
    globList.map((glob) => path.resolve(projectPath, glob)),
    {
      absolute: true,
      onlyDirectories: isDirOnly,
      deep: 1,
      objectMode: true,
    }
  );
}

async function getDirsAndFiles(projectPath: string, globList: string[]) {
  return [
    ...(await getGlobPaths(projectPath, globList, false)),
    ...(await getGlobPaths(projectPath, globList, true)),
  ];
}
