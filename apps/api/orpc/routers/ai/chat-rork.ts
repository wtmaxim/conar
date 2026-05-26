import type { AppUIMessage } from '@conar/ai/tools/helpers'
import process from 'node:process'
import { ConnectionType } from '@conar/shared/enums/connection-type'
import { streamToEventIterator } from '@orpc/server'
import { createUIMessageStream } from 'ai'
import { type } from 'arktype'
import { v7 } from 'uuid'
import { authMiddleware, orpc } from '~/orpc'

interface RorkTextPart {
  type: 'text'
  text: string
}

interface RorkImagePart {
  type: 'image'
  image: string
}

interface RorkResponse {
  completion: string
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    total_tokens?: number
  }
  model?: string
  finish_reason?: string
}

const FINISH_REASON_MAP = new Set(['stop', 'length', 'content-filter', 'tool-calls', 'error', 'other'] as const)
const MAX_TOOL_STEPS = 5

interface ColumnsToolInput {
  tableAndSchema: {
    tableName: string
    schemaName: string
  }
}

interface ContextColumn {
  name: string
  type: string | undefined
  isNullable: boolean | undefined
}

interface ContextTableColumns {
  schema: string
  table: string
  columns: ContextColumn[]
}

interface ToolAction {
  action: 'tool'
  name: string
  input?: unknown
}

interface AnswerAction {
  action: 'answer'
  text: string
}

function stripDataUriPrefix(dataUrlOrBase64: string) {
  return dataUrlOrBase64.replace(/^data:.*?;base64,/, '')
}

function toRorkContent(parts: AppUIMessage['parts']): string | Array<RorkTextPart | RorkImagePart> {
  const content: Array<RorkTextPart | RorkImagePart> = []

  for (const part of parts) {
    if (part.type === 'text') {
      content.push({ type: 'text', text: part.text })
      continue
    }

    if (part.type === 'file' && part.mediaType.startsWith('image/')) {
      content.push({ type: 'image', image: stripDataUriPrefix(part.url) })
    }
  }

  if (content.length === 0) {
    return ''
  }

  return content
}

function extractJsonObject(text: string): unknown {
  const trimmed = text.trim()

  try {
    return JSON.parse(trimmed)
  }
  catch {}

  const fenceStart = trimmed.indexOf('```')
  const fenceEnd = trimmed.lastIndexOf('```')
  if (fenceStart !== -1 && fenceEnd > fenceStart) {
    const fenced = trimmed.slice(fenceStart + 3, fenceEnd).trim()
    const unfenced = fenced.startsWith('json')
      ? fenced.slice(4).trim()
      : fenced

    try {
      return JSON.parse(unfenced)
    }
    catch {}
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    try {
      return JSON.parse(trimmed.slice(firstBrace, lastBrace + 1))
    }
    catch {}
  }

  return null
}

function parseAction(text: string): ToolAction | AnswerAction | null {
  const parsed = extractJsonObject(text)
  if (!parsed || typeof parsed !== 'object') {
    return null
  }

  const action = Reflect.get(parsed, 'action')
  if (action === 'answer') {
    const answerText = Reflect.get(parsed, 'text')
    if (typeof answerText === 'string') {
      return { action: 'answer', text: answerText }
    }
  }

  if (action === 'tool') {
    const name = Reflect.get(parsed, 'name')
    if (typeof name === 'string') {
      return {
        action: 'tool',
        name,
        input: Reflect.get(parsed, 'input'),
      }
    }
  }

  return null
}

function parseColumnsFromContext(context: string): ContextTableColumns[] {
  const marker = 'Database columns by table:'
  const markerIndex = context.indexOf(marker)
  if (markerIndex === -1) {
    return []
  }

  const afterMarker = context.slice(markerIndex + marker.length).trim()
  const parsed = extractJsonObject(afterMarker)

  if (!Array.isArray(parsed)) {
    return []
  }

  return parsed
    .map((item) => {
      if (!item || typeof item !== 'object') {
        return null
      }

      const schema = Reflect.get(item, 'schema')
      const table = Reflect.get(item, 'table')
      const columns = Reflect.get(item, 'columns')

      if (typeof schema !== 'string' || typeof table !== 'string' || !Array.isArray(columns)) {
        return null
      }

      return {
        schema,
        table,
        columns: columns
          .map((column) => {
            if (!column || typeof column !== 'object') {
              return null
            }

            const name = Reflect.get(column, 'name')
            const type = Reflect.get(column, 'type')
            const isNullable = Reflect.get(column, 'isNullable')

            if (typeof name !== 'string') {
              return null
            }

            return {
              name,
              type: typeof type === 'string' ? type : undefined,
              isNullable: typeof isNullable === 'boolean' ? isNullable : undefined,
            } satisfies ContextColumn
          })
          .filter((column): column is ContextColumn => column !== null),
      } satisfies ContextTableColumns
    })
    .filter((item): item is ContextTableColumns => item !== null)
}

function executeToolFromContext(name: string, input: unknown, context: string): unknown {
  if (name === 'columns') {
    const columnsByTable = parseColumnsFromContext(context)
    if (columnsByTable.length === 0) {
      return { error: 'Columns context is missing.' }
    }

    const typedInput = input as ColumnsToolInput | undefined
    const schemaName = typedInput?.tableAndSchema?.schemaName
    const tableName = typedInput?.tableAndSchema?.tableName

    if (!schemaName || !tableName) {
      return { error: 'Invalid input for columns tool.' }
    }

    const found = columnsByTable.find(item =>
      item.schema.toLowerCase() === schemaName.toLowerCase()
      && item.table.toLowerCase() === tableName.toLowerCase(),
    )

    if (!found) {
      return { error: `Table ${schemaName}.${tableName} not found.` }
    }

    return found.columns
  }

  if (name === 'enums') {
    return { error: 'enums tool is not available in rork context yet.' }
  }

  if (name === 'select') {
    return { error: 'select tool is not available in rork context route.' }
  }

  return { error: `Unknown tool: ${name}` }
}

export const chatRork = orpc
  .use(authMiddleware)
  .input(type({
    id: 'string.uuid.v7',
    type: type.valueOf(ConnectionType),
    context: 'string',
    createdAt: 'Date',
    updatedAt: 'Date',
    messages: 'object[]' as type.cast<AppUIMessage[]>,
  }))
  .handler(async ({ input, context }) => {
    const rorkBaseUrl = process.env.RORK_TOOLKIT_URL ?? 'https://toolkit.rork.com'
    const url = `${rorkBaseUrl.replace(/\/$/, '')}/text/llm/`
    const baseSystemPrompt = [
      '<role>',
      `You are Conar AI, an expert ${input.type} database assistant embedded in a production database editor. You help users write, understand, debug, and optimize SQL queries. You are concise, precise, and security-conscious.`,
      '</role>',
      '',
      '<rules>',
      'Response format:',
      '- Reply in the same language as the user\'s message.',
      '- Use markdown. Place each SQL query in its own ```sql code block.',
      '- Do not use headings (no # or ##). Keep answers flat and scannable.',
      '- When generating SQL, briefly explain what the query does and why you wrote it that way.',
      '- When a query involves joins, subqueries, CTEs, or window functions, explain the logic step by step.',
      '- If a query could be slow on large tables, proactively mention it and suggest alternatives (indexes, LIMIT, pagination).',
      '- If the user asks to modify specific lines in their current query, generate only the changed part — not the entire query.',
      '',
      'SQL generation:',
      `- Write valid, production-ready SQL for the ${input.type} dialect only.`,
      '- Reference only schemas, tables, columns, and enums provided in the context below — never hallucinate names.',
      '- Always quote identifiers (table and column names) to prevent case-sensitivity errors.',
      '- Use 2-space indentation and consistent formatting.',
      '- Prefer explicit column lists over SELECT *.',
      '- Always include a LIMIT unless the user explicitly asks for all rows.',
      '',
      'Security:',
      '- The generated SQL will be executed directly against a live database. Treat every query as production.',
      '- Never generate DROP, TRUNCATE, or DELETE without a WHERE clause unless the user explicitly requests it, and add a warning.',
      '- If a request seems destructive or risky, confirm the user\'s intent before providing the query.',
      '</rules>',
      '',
      '<tool_protocol>',
      'When you need additional data, return ONLY JSON:',
      '{"action":"tool","name":"columns|enums|select","input":{...}}',
      'When you are ready to answer, return ONLY JSON:',
      '{"action":"answer","text":"..."}',
      'Do not include markdown or extra text around JSON in tool mode.',
      '</tool_protocol>',
      '',
      '<context>',
      `Database dialect: ${input.type}`,
      `Current date and time: ${new Date().toISOString()}`,
      '',
      input.context,
      '</context>',
    ].join('\n')

    const messages = input.messages.map(message => ({
      role: message.role,
      content: toRorkContent(message.parts),
    }))

    context.addLogData({
      chatId: input.id,
      messagesCount: input.messages.length,
      provider: 'rork-toolkit',
      endpoint: '/text/llm/',
    })

    const runRork = async (requestMessages: Array<{ role: string, content: string | Array<RorkTextPart | RorkImagePart> }>) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          messages: [
            {
              role: 'system',
              content: baseSystemPrompt,
            },
            ...requestMessages,
          ],
        }),
      })

      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(`Rork Toolkit request failed with ${response.status}: ${body.slice(0, 300)}`)
      }

      return response.json() as Promise<RorkResponse>
    }

    let completion = ''
    let finishReason: RorkResponse['finish_reason'] = 'stop'
    const loopMessages = [...messages]

    for (let i = 0; i < MAX_TOOL_STEPS; i++) {
      const data = await runRork(loopMessages)
      completion = data.completion ?? ''
      finishReason = data.finish_reason ?? 'stop'

      const action = parseAction(completion)
      if (!action) {
        break
      }

      if (action.action === 'answer') {
        completion = action.text
        break
      }

      const toolResult = executeToolFromContext(action.name, action.input, input.context)

      loopMessages.push({
        role: 'assistant',
        content: JSON.stringify(action),
      })
      loopMessages.push({
        role: 'user',
        content: [
          {
            type: 'text',
            text: `TOOL_RESULT ${JSON.stringify({
              name: action.name,
              input: action.input ?? null,
              output: toolResult,
            })}`,
          },
        ],
      })
    }

    const stream = createUIMessageStream({
      originalMessages: input.messages,
      generateId: () => v7(),
      execute: ({ writer }) => {
        const textId = v7()
        writer.write({ type: 'start' })
        writer.write({ type: 'start-step' })
        writer.write({ type: 'text-start', id: textId })

        const finalCompletion = completion || ''
        const chunkSize = 128
        for (let i = 0; i < finalCompletion.length; i += chunkSize) {
          writer.write({
            type: 'text-delta',
            id: textId,
            delta: finalCompletion.slice(i, i + chunkSize),
          })
        }

        writer.write({ type: 'text-end', id: textId })
        writer.write({ type: 'finish-step' })
        writer.write({
          type: 'finish',
          finishReason: finishReason && FINISH_REASON_MAP.has(finishReason as never)
            ? finishReason as 'stop' | 'length' | 'content-filter' | 'tool-calls' | 'error' | 'other'
            : 'stop',
        })
      },
      onError: () => 'Sorry, I was unable to generate a response due to an error. Please try again.',
    })

    return streamToEventIterator(stream)
  })
