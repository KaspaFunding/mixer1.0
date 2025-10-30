import { version } from '../../../package.json'
import { stylize, Code, getReadableDate, getReadableTime } from './styling'

export default class Monitoring {
  constructor () {
    console.log(`Kaspa Mining v${version}`)
  }

  log (message: string) {
    console.log(this.buildMessage(stylize(Code.bgYellowLight, 'LOG'), message))
  }

  private buildMessage (prefix: string, message: string) {
    return `${stylize(Code.green, getReadableDate())} ${stylize(Code.cyan, getReadableTime())} ${prefix} ${message}`
  }
}