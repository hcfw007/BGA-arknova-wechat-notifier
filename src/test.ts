import { TableObserver } from "./service/tableObserver"

async function main() {
  const tableObserver = new TableObserver('828845209')
  await tableObserver.init()

  tableObserver.on('ready', () => {
    console.log(`table ${tableObserver.tableId} ready`)
    console.log(tableObserver.currentState)
    console.log(tableObserver.currentPlayers)
  }).on('end', () => {
    console.log('game ended')
    tableObserver.close()
  }).on('newPlayerMove', (newPlayers: string[]) => {
    console.log('newPlayerMove', newPlayers)
  }).on('error', () => {
    console.log('error')
  })
}

main()
