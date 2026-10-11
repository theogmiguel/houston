export const CONNECT_PHONE_EVENT = 'houston:connect-phone'

export type ConnectPhoneStep = 'route' | 'scan'

/** Opens the Connect phone dialog on its code step when remote access is already on, otherwise on the route step. */
export function openConnectPhone(): void {
  window.dispatchEvent(new CustomEvent<{ step?: ConnectPhoneStep }>(CONNECT_PHONE_EVENT, { detail: {} }))
}

/** Opens the Connect phone dialog on its route and address form, for editing how phones reach this computer. */
export function openConnectPhoneRoute(): void {
  window.dispatchEvent(new CustomEvent<{ step?: ConnectPhoneStep }>(CONNECT_PHONE_EVENT, { detail: { step: 'route' } }))
}
