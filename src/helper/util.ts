export const stateRegulator = (state: string): string => {
  return state.replace(/\n+/g, ' ').replace(/ +/g, ' ')
}