import { chunk as makeChunk } from 'lodash'

import { System, ParserOptions, CommandOptions, UserPermissions } from 'typings'
import { User } from '@bot/entities/User'
import tmi from '@bot/libs/tmi'
import { UserDailyMessages } from '@bot/entities/UserDailyMessages'
import twitch from './twitch'
import { TwitchPrivateMessage } from 'twitch-chat-client/lib/StandardCommands/TwitchPrivateMessage'
import { orm } from '@bot/libs/db'
import { CommandPermission } from '@bot/entities/Command'
import { settings } from '../decorators'
import { parser } from '../decorators/parser'
import { command } from '../decorators/command'

class Users implements System {
  private countWatchedTimeout: NodeJS.Timeout = null
  private getChattersTimeout: NodeJS.Timeout = null
  chatters: Array<{ username: string, id: string }> = []

  @settings()
  enabled = true

  @settings()
  ignoredUsers: string[] = []

  @settings()
  botAdmins: string[] = []

  @settings()
  points = {
    enabled: true,
    messages: {
      interval: 1,
      amount: 1,
    },
    watch:{
      interval: 1,
      amount: 1,
    },
  }


  async init() {
    await this.getChatters()
    await this.countWatched()
  }

  @parser()
  async parseMessage(opts: ParserOptions) {
    if (!this.enabled || opts.message.startsWith('!')) return
    if (this.isIgnored(opts.raw.userInfo.userName) || this.isIgnored(opts.raw.userInfo.userId)) return
    if (!twitch.streamMetaData.startedAt) return

    const [pointsPerMessage, pointsInterval] = [this.points.messages.amount, this.points.messages.interval * 60 * 1000]

    const [id, username] = [opts.raw.userInfo.userId, opts.raw.userInfo.userName]

    const repository = orm.em.fork().getRepository(User)
    const user = await repository.findOne(Number(id)) || repository.assign(new User(), { id: Number(id), username, messages: 0 })

    user.username = opts.raw.userInfo.userName
    user.messages +=  1

    const updatePoints = (Number(user.lastMessagePoints) + pointsInterval <= user.messages) && this.points.enabled

    if (updatePoints && twitch.streamMetaData?.startedAt && pointsPerMessage !== 0 && pointsInterval !== 0) {
      user.points = user.points + pointsPerMessage
      user.lastMessagePoints = new Date().getTime()
    }

    await repository.persistAndFlush(user)

    const now = new Date()
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate())

    const dailyRepository = orm.em.fork().getRepository(UserDailyMessages)
    const daily = await dailyRepository.findOne({ user: user.id, date: startOfDay.getTime() }) || dailyRepository.assign(new UserDailyMessages(), {
      user,
      date: startOfDay.getTime(),
    })

    daily.count += 1
    await dailyRepository.persistAndFlush(daily)
  }

  async getUserStats({ id, username }: { id?: string, username?: string }): Promise<User> {
    if (!id && !username) throw new Error('Id or username should be used.')

    if (!id) {
      const byName = await tmi.bot.api?.helix.users.getUserByName(username)
      id = byName.id
      username = byName.name
    }

    const repository = orm.em.fork().getRepository(User)
    const user = await repository.findOne(Number(id), ['tips', 'bits', 'daily'])

    if (user) return user

    const create = repository.assign(new User(), { id: Number(id), username })
    await repository.persistAndFlush(create)
    return create
  }

  private async countWatched() {
    clearTimeout(this.countWatchedTimeout)
    this.countWatchedTimeout = setTimeout(() => this.countWatched(), 1 * 60 * 1000)
    const [pointsPerWatch, pointsInterval] = [this.points.watch.amount, this.points.watch.interval * 60 * 1000]

    if (!twitch.streamMetaData?.startedAt || !this.enabled) return

    const repository = orm.em.fork().getRepository(User)
    const usersForUpdate: User[] = []

    for (const chatter of this.chatters) {
      if (this.isIgnored(chatter.username.toLowerCase())) continue

      const user = await repository.findOne(Number(chatter.id)) || repository.assign(new User(), { id: Number(chatter.id), username: chatter.username })

      const updatePoints = (new Date().getTime() - new Date(user.lastWatchedPoints).getTime() >= pointsInterval) && this.points.enabled

      if (pointsPerWatch !== 0 && pointsInterval !== 0 && updatePoints) {
        user.lastWatchedPoints = new Date().getTime()
        user.points += pointsPerWatch
      }

      user.watched += 1 * 60 * 1000
      usersForUpdate.push(user)
    }

    await repository.persistAndFlush(usersForUpdate)
  }

  private async getChatters() {
    clearTimeout(this.getChattersTimeout)
    this.getChattersTimeout = setTimeout(() => this.getChatters(), 5 * 60 * 1000)

    this.chatters = []

    for (const chunk of makeChunk((await tmi.bot.api?.unsupported.getChatters(tmi.channel?.name))?.allChatters, 100)) {

      const users = (await tmi.bot.api?.helix.users.getUsersByNames(chunk)).map(user => ({ username: user.name, id: user.id }))

      this.chatters.push(...users)
    }
  }

  @command({
    name: 'sayb',
    permission: CommandPermission.BROADCASTER,
    visible: false,
    description: 'commands.sayb.description',
  })
  sayb(opts: CommandOptions) {
    tmi.broadcaster.chat?.say(tmi.channel?.name, opts.argument)
  }

  getUserPermissions(badges: Map<string, string>, raw?: TwitchPrivateMessage): UserPermissions {
    return {
      broadcaster: badges.has('broadcaster') || this.botAdmins?.includes(raw?.userInfo.userName),
      moderators: badges.has('moderator'),
      vips: badges.has('vip'),
      subscribers: badges.has('subscriber') || badges.has('founder'),
      viewers: true,
    }
  }

  hasPermission(badges: Map<string, string>, searchForPermission: CommandPermission, raw?: TwitchPrivateMessage) {
    if (!searchForPermission) return true

    const userPerms = Object.entries(this.getUserPermissions(badges, raw))
    const commandPermissionIndex = userPerms.indexOf(userPerms.find(v => v[0] === searchForPermission))

    return userPerms.some((p, index) => p[1] && index <= commandPermissionIndex)
  }

  @command({
    name: 'ignore add',
    permission: CommandPermission.MODERATORS,
    visible: false,
    description: 'commands.ignore.add.description',
  })
  async ignoreAdd(opts: CommandOptions) {
    if (!opts.argument.length) return

    this.ignoredUsers = [...this.ignoredUsers, opts.argument.toLowerCase()]

    return '$sender ✅'
  }

  @command({
    name: 'ignore remove',
    permission: CommandPermission.MODERATORS,
    visible: false,
    description: 'commands.ignore.remove.description',
  })
  async ignoreRemove(opts: CommandOptions) {
    if (!opts.argument.length) return

    if (!this.isIgnored(opts.argument.toLowerCase())) return

    this.ignoredUsers.splice(this.ignoredUsers.indexOf(opts.argument.toLowerCase()), 1)

    return '$sender ✅'
  }

  isIgnored(user: string | number) {
    return this.ignoredUsers?.includes(String(user))
  }

}

export default new Users()
