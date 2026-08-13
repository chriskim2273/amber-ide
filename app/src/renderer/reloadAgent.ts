import { CLAUDE_SESSION_ID } from '../shared/ids'

export type AgentName = 'claude' | 'grok' | 'codex'

const CODEX_FLAGS = '--dangerously-bypass-approvals-and-sandbox --dangerously-bypass-hook-trust'
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f-\u009f]/

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

export function reloadAgentCommand(agent: AgentName, id: string | null): string | null {
  if (id !== null) {
    if (id.trim() === '' || CONTROL_CHARACTER.test(id)) return null
    if (agent !== 'codex' && !CLAUDE_SESSION_ID.test(id)) return null
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
