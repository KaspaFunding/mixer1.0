import { stylize, Code, getReadableDate, getReadableTime } from './styling'

export default class Monitoring {
  constructor () {
    // Use a constant version string instead of importing from package.json
    // This avoids import path issues and is simpler for a logging utility
    console.log(`Kaspa Mining v1.0.0`)
  }

  log (message: string) {
    console.log(this.buildMessage(stylize(Code.bgYellowLight, 'LOG'), message))
  }

  private buildMessage (prefix: string, message: string) {
    return `${stylize(Code.green, getReadableDate())} ${stylize(Code.cyan, getReadableTime())} ${prefix} ${message}`
  }
}