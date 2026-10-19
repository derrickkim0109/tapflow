import { fetchWithToken, resolveToken, tokenRefusal, type TokenSource } from '@tapflowio/flow-runner'
import { TapflowClient } from './client.js'

/**
 * Connects the MCP server's client, or says why it cannot and answers null (the process then exits 1).
 *
 * The token is `TAPFLOW_TOKEN`, else the credentials file for this relay — re-read when the relay refuses it, so
 * rotating a token is writing the file rather than re-registering this server (T1).
 */
export async function startClient(env: NodeJS.ProcessEnv, stderr: (line: string) => void): Promise<TapflowClient | null> {
  const relayUrl = env['TAPFLOW_RELAY_URL'] ?? 'ws://localhost:4000'
  let tokens: TokenSource
  try {
    tokens = resolveToken({ relayUrl, env, warn: stderr })
  } catch (e) {
    stderr(`TAPFLOW_RELAY_URL is not a relay URL (${JSON.stringify(relayUrl)}): ${(e as Error).message} — use e.g. ws://localhost:4000`)
    return null
  }
  const client = new TapflowClient(relayUrl, tokens)

  try {
    await client.connect()
  } catch (e) {
    stderr(`Failed to connect to relay at ${relayUrl}: ${(e as Error).message}`)
    return null
  }

  // **Whether a token is needed is not decided from the URL.** The relay knows whether this socket is local — its
  // tunnel port and a Docker bridge are not, though both are `localhost` here — and says so by closing it 1008
  // right after the upgrade. One round trip finds out; a refusal is fatal as it always was, now naming the relay,
  // where the token came from, and the fix.
  try {
    await client.listDevices()
  } catch (e) {
    // A refusal arrives as a close frame right after the upgrade; the request can fail on the closing socket before
    // its close event says why. Read the code once it has.
    await client.closeSettled()
    // Only a 1008 is the relay refusing the credential. A slow relay (one waking from sleep) or another close is not
    // the token's fault: started anyway, as before this check existed, and each tool says what it meets.
    if (client.lastCloseCode !== 1008) {
      stderr(`The relay at ${tokens.origin} did not answer the first request: ${(e as Error).message}; starting anyway`)
      return client
    }
    stderr(`The relay at ${tokens.origin} refused this connection: ${(e as Error).message}`)
    stderr(tokens.token
      ? tokenRefusal(tokens)
      : `${tokenRefusal(tokens)}. The relay counts only its own port on its own Mac as local, so a tunnel port or a container needs one too`)
    client.disconnect()
    return null
  }

  // A token the socket accepts can still be refused by REST (screenshot, ui-tree, builds), which checks it even on
  // loopback. Said at start, where the MCP log is read; not fatal, since the socket tools still work.
  if (tokens.token) {
    const res = await fetchWithToken(tokens, new URL('/api/v1/apps', tokens.origin).toString(), {}).catch(() => null)
    if (res?.status === 401) stderr(tokenRefusal(tokens))
    else if (res?.status === 403) stderr(`the token for ${tokens.origin} lacks the view scope, so screenshot, query_ui_tree, list_builds, list_runs and get_run will be refused`)
    await res?.body?.cancel().catch(() => {})
  } else {
    stderr(`${tokenRefusal(tokens)}; until then screenshot, query_ui_tree, list_builds, list_runs and get_run are refused`)
  }
  return client
}
