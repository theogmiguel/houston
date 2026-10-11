export const CONNECT_PHONE_EVENT = 'houston:connect-phone'

export function openConnectPhone(): void {
  window.dispatchEvent(new Event(CONNECT_PHONE_EVENT))
}
