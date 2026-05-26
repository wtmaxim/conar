import { db } from '@conar/db'
import { chats, chatsInsertSchema } from '@conar/db/schema'
import { authMiddleware, orpc } from '~/orpc'
import { publisher } from './events'

export const create = orpc
  .use(authMiddleware)
  .input(chatsInsertSchema.omit('userId', 'activeStreamId', 'title'))
  .handler(async ({ context, input }) => {
    const [chat] = await db.insert(chats).values({
      ...input,
      activeStreamId: null,
      userId: context.user.id,
    }).returning()

    publisher.publish('event', {
      type: 'insert',
      value: chat!,
      clientId: context.clientId,
    })
  })
