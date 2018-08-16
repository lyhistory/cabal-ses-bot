import fs from 'fs'
import path from 'path'
import SES from 'ses'
import debug from 'debug'
import EventEmitter from 'events'
import chalk from 'chalk'
import PQueue from 'p-queue'
import dedent from 'dedent'
import makeRootBotMixin from './root-bot-mixin'

class SesBot extends EventEmitter {}

const sesBot = new SesBot()

const debugLog = debug('ses-bot')

const r = SES.makeSESRootRealm()

debugLog('Debug on')

function buildBotKernelSrc () {
  let def, log, debugLog

  function kernel () {
    let messageCounter = 0
    let processes = []
    let state = []
    let refs = []
    let storageDir

    const definitions = {
      setStorageDir: dir => storageDir = dir,
      register,
      send,
      kill: id => processes[id].killed = true,
    }
    return def(definitions) // Freeze 'em

    function register (botName, handlerFunc) {
      const pid = processes.length
      processes[pid] = {
        botName,
        handlerFunc,
        queue: new PQueue({concurrency: 1})
      }
      debugLog('Registered handler at PID:', pid, botName, handlerFunc)
      return pid
    }

    function send (message, cb) {
      const id = 'm' + ++messageCounter
      debugLog(id, `Message:`, message)
      const promises = processes.map((proc, pid) => {
        const {botName, handlerFunc, killed, queue} = proc
        const {author} = message
        if (killed) return
        if (author === botName) return
        const promise = queue.add(() => getPromise())
        return promise

        function handlerLog () {
          debugLog(`${id} PID ${pid}`, ...arguments)
        }

        function getPromise () {
          try {
            handlerLog('State:', state[pid])
            const endowments = {
              module: {},
              console: {
                log: (...rest) => {
                  handlerLog('Log:', ...rest)
                  log(chalk.blue(`PID ${pid} ${botName}:`), ...rest)
                }
              },
              botName,
              message,
              state: state[pid],
              refs: refs[pid],
              setState: newState => state[pid] = newState,
              setRefs: newRefs => refs[pid] = newRefs,
              chat: {
                send: message => {
                  handlerLog('Emit:', message)
                  if (!message.options || !message.options.username) {
                    if (!message.options) message.options = {}
                    message.options.username = botName
                  }
                  emit(message)
                }
              },
              sleep: delay => new Promise(resolve => {
                setTimeout(resolve, delay)
              }),
              dedent
            }
            if (pid === 0) { // Root bot extra endowments
              Object.assign(endowments, makeRootBotMixin({
                processes,
                debugLog,
                storageDir,
                register
              }))
            }
            return SES
              .confine(
                `${handlerFunc}; module.exports(botName, message, state, refs)`,
                endowments
              )
              .then(result => {
                handlerLog('Success:', result)
                if (pid === 0) return {result}
                const jsonStateFile = path.join(
                  storageDir, 'bots', `${pid}`, 'state.json'
                )
                return new Promise((resolve, reject) => {
                  const json = JSON.stringify(state[pid], null, 2)
                  fs.writeFile(jsonStateFile, json, err => {
                    if (err) return reject()
                    resolve({result})
                  })
                })
              })
              .catch(err => {
                handlerLog('Fail:', err.name, err.message, err.stack)
                log(chalk.red(`PID ${pid} ${botName}:`),
                    err.name + ':', err.message)
                emit({
                  channel: message.channel,
                  message: `Error PID ${pid} ${botName}:` +
                            `${err.name}: ${err.message}`,
                  options: {username: botName}
                })
              })
          } catch (e) {
            const err = {
              name: e.name,
              message: e.message,
              code: e.code,
              stack: e.stack
            }
            handlerLog('Fail:', err)
            log(chalk.red(`PID ${pid} ${botName}:`), e.name + ':', e.message)
            emit({
              channel: message.channel,
              message: `Error PID ${pid} ${botName}: ${e.name}: ${e.message}`,
              options: {username: botName}
            })
            return Promise.resolve({error: err})
          }
        }
      })
      const allPromises = Promise.all(promises)
        .then(results => {
          debugLog(id, 'Handlers finished')
          cb(null, results)
        })
        .catch(err => {
          debugLog(id, 'Error', err)
          cb(err)
        })
      return allPromises
    }
  }

  return `${kernel}; kernel()`
}

const botKernel = r.evaluate(buildBotKernelSrc(), {
  log: console.log,
  debugLog,
  emit,
  chalk,
  setTimeout,
  PQueue,
  dedent,
  fs,
  path,
  makeRootBotMixin
})

function emit (message) {
  sesBot.emit('message', message)
}

export function registerRootBot(nick, dir) {
  const rootBotFile = path.resolve(__dirname, 'root-bot.js')
  const rootBotSource = fs.readFileSync(rootBotFile, 'utf8')
  botKernel.setStorageDir(dir)
  botKernel.register(nick, rootBotSource)
}

export function send (message, cb) {
  botKernel.send(message, cb)
}

export default sesBot

