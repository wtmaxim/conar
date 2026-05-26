import process from 'node:process'
import { InfisicalSDK } from '@infisical/sdk'
import { type } from 'arktype'
import { memoize } from 'memoza'
import { secrets } from './secrets'

export const env = type({
  INFISICAL_SITE_URL: 'string',
  INFISICAL_CLIENT_ID: 'string',
  INFISICAL_CLIENT_SECRET: 'string',
  INFISICAL_PROJECT_ID: 'string',
  INFISICAL_ENVIRONMENT: 'string',
}).assert(process.env)

export const baseOptions = {
  projectId: env.INFISICAL_PROJECT_ID,
  environment: env.INFISICAL_ENVIRONMENT,
}

export const getClient = memoize(async () => {
  const client = new InfisicalSDK({ siteUrl: env.INFISICAL_SITE_URL })
  await client.auth().universalAuth.login({
    clientId: env.INFISICAL_CLIENT_ID,
    clientSecret: env.INFISICAL_CLIENT_SECRET,
  })
  return client
})

export function pathToString(path: string[]) {
  return path.length === 0 ? '/' : `/${path.join('/')}`
}

function getStatusCode(error: unknown): number | undefined {
  if (!error || typeof error !== 'object') {
    return undefined
  }

  const directStatusCode = Reflect.get(error, 'statusCode')
  if (typeof directStatusCode === 'number') {
    return directStatusCode
  }

  const response = Reflect.get(error, 'response')
  if (response && typeof response === 'object') {
    const responseStatus = Reflect.get(response, 'status')
    if (typeof responseStatus === 'number') {
      return responseStatus
    }

    const responseStatusCode = Reflect.get(response, 'statusCode')
    if (typeof responseStatusCode === 'number') {
      return responseStatusCode
    }
  }

  const cause = Reflect.get(error, 'cause')
  if (cause && typeof cause === 'object') {
    const causeStatusCode = Reflect.get(cause, 'statusCode')
    if (typeof causeStatusCode === 'number') {
      return causeStatusCode
    }
  }

  return undefined
}

export function isFolderMissingError(error: unknown): boolean {
  const statusCode = getStatusCode(error)
  if (statusCode === 404) {
    return true
  }

  if (!(error instanceof Error)) {
    return false
  }

  const message = error.message.toLowerCase()
  return message.includes('statuscode=404')
    || message.includes('status code: 404')
    || message.includes('status code 404')
    || message.includes('404 not found')
}

export async function ensureFolders(folders: string[]) {
  if (folders.length === 0)
    return

  const client = await getClient()

  for (let i = 0; i < folders.length; i++) {
    const parent = i === 0 ? '/' : `/${folders.slice(0, i).join('/')}`
    await client.folders().create({
      ...baseOptions,
      name: folders[i]!,
      path: parent,
    }).catch(() => {})
  }
}

export const infisical = {
  secrets,
}
