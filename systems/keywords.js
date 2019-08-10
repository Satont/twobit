const variables = require('./variables')
const { io } = require('../libs/panel')
const { say } = require('./customCommands')

class Keywords {
  constructor() {
    this.keywords = []
    this.sockets()
    this.getKeywordsList()
  }
  async check(message, userstate) {
    for (let item of this.keywords) {
      if (message.includes(item.name)) return this.respond(item, message, userstate)
    }
  }
  async respond(item, message, userstate) {
    let response = item.response
    response = await variables.prepareMessage(response, userstate, message)
    await say(response)
  }
  async getKeywordsList() {
    let query = await global.db.select(`*`).from('systems.keywords')
    this.keywords = query
    return query
  }
  async sockets() {
    let self = this
    io.on('connection', function (socket) {
      socket.on('list.keywords', async (data, cb) => {
        let query = await global.db.select(`*`).from('systems.keywords')
        cb(null, query)
      })
      socket.on('create.keyword', async (data, cb) => {
        let maped = self.keywords.map(o => o.name)
        
        if (maped.includes(data.name)) return cb('This keyword already in use', null)
        try {
          await global.db('systems.keywords').insert(data)
          self.getKeywordsList()
          cb(null, true)
        } catch (e) {
          console.log(e)
        }
      })
      socket.on('delete.keyword', async (data, cb) => {
        try {
          await global.db('systems.keywords').where('name', data.replace('%20', ' ')).delete()
          self.getKeywordsList()
        } catch (e) {
          console.log(e)
        }
      })
      socket.on('update.keyword', async (data, cb) => {
        let maped = self.keywords.map(o => o.name)

        if (maped.includes(data.name)) return cb('Keyword name already in use', null)

        let name = data.currentname.replace('%20', ' ')
        delete data.currentname
        try {
          await global.db('systems.keywords').where('name', name).update(data)
          self.getKeywordsList()
          cb(null, true)
        } catch (e) {
          console.log(e)
        }
      })
    })
  }
}

module.exports = new Keywords()