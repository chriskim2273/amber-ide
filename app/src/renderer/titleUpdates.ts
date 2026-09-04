export interface TitleUpdateRequest {
  name: string
  title: string | null
}

export interface TitleUpdateResult {
  name: string
  title?: string | null | undefined
}

export interface TitleCreateState {
  created: boolean
  acknowledged: boolean
}

export function titleCreateComplete(state: TitleCreateState): boolean {
  return state.created && state.acknowledged
}

/** Match an acknowledgement or authoritative SessionInfo update to a request. */
export function titleUpdateMatches(request: TitleUpdateRequest, result: TitleUpdateResult): boolean {
  return request.name === result.name && request.title === (result.title ?? null)
}
