import { CLAUDE_SESSION_ID } from '../shared/ids'

export type AgentName = 'claude' | 'grok' | 'codex' | 'opencode' | 'pi'
export interface ReloadAgentVisibility {
  show: boolean
  resumeSaved: boolean
  pickSession: boolean
}

const CODEX_FLAGS = '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust'
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/
const OPENCODE_SESSION_ID = /^ses_[0-9A-Za-z]+$/
const PI_SESSION_ID = /^[0-9A-Za-z](?:[0-9A-Za-z-]*[0-9A-Za-z])?$/

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

// The picker is a safe recovery path for every agent. Pi particularly needs it
// before its extension has recorded a session id, so visibility cannot depend
// on `claude_id` being present.
export function reloadAgentVisibility(agent: AgentName, id: string | null): ReloadAgentVisibility {
  return {
    show: true,
    resumeSaved: id !== null && reloadAgentCommand(agent, id) !== null,
    pickSession: true,
  }
}

export function reloadAgentCommand(agent: AgentName, id: string | null): string | null {
  if (id !== null) {
    if (id.trim() === '' || CONTROL_CHARACTER.test(id)) return null
    if (agent === 'pi') {
      if (id.length < 8 || !PI_SESSION_ID.test(id)) return null
    } else if (agent === 'opencode') {
      if (!OPENCODE_SESSION_ID.test(id)) return null
    } else if (agent !== 'codex' && !CLAUDE_SESSION_ID.test(id)) return null
  }

  if (agent === 'pi') return id === null ? 'pi -r' : `pi --session ${shellQuote(id)}`

  if (agent === 'opencode') {
    return id === null
      ? 'opencode --auto'
      : `opencode --auto -s ${shellQuote(id)}`
  }

  if (agent === 'codex') {
    return id === null
      ? `codex resume ${CODEX_FLAGS}`
      : `codex resume ${CODEX_FLAGS} -- ${shellQuote(id)}`
  }

  const resume = id === null ? ' --resume' : ` --resume ${id}`
  return agent === 'grok'
    ? `grok --permission-mode bypassPermissions${resume}`
    : `claude --dangerously-skip-permissions${resume}`
}
