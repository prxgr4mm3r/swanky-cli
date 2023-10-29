import {execaCommand} from "execa";
import {SwankyCommand} from "../../lib/swankyCommand.js";

export default class Clear extends SwankyCommand<typeof Clear> {
  static description = 'Clears all the artifacts, test artifacts, cargo target directory'

  public async run(): Promise<void> {
      await this.spinner.runCommand(
          () => execaCommand( 'rm -r artifacts'),
          "Clearing artifacts directory",
          "Cleared artifacts directory"
      )
      await this.spinner.runCommand(
          () => execaCommand( 'rm -r target'),
          "Clearing cargo target directory",
            "Cleared cargo target directory"
      )

      const contractNames = Object.keys(this.swankyConfig.contracts)
      await this.spinner.start("Clearing test artifacts")
      for(const contractName of contractNames) {
                  execaCommand(`rm -r tests/${contractName}/artifacts`)
      }
      this.spinner.succeed("Cleared test artifacts directories")
  }
}