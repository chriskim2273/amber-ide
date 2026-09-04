export interface TitleUpdateRequest {
  name: string
  title: string | null
}

export interface TitleUpdateResult {
  name: string
  title?: string | null | undefined
}

/** Match an acknowledgement or authoritative SessionInfo update to a request. */
export function titleUpdateMatches(request: TitleUpdateRequest, result: TitleUpdateResult): boolean {
  return request.name === result.name && request.title === (result.title ?? null)
}
