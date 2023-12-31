const requiredConfig = {
  token: process.env.PADPLUS_TOKEN,
  endpoint: process.env.PADPLUS_ENDPOINT,
} as const

const optionalConfig = {
  alarmReceiver: process.env.ALARM_CONTACT_ID,
  puppetHeadless: !(process.env.PUPPET_HEADLESS === 'false')
} as const

for (const key in requiredConfig) {
  if (typeof requiredConfig[key] === 'undefined') {
    throw new Error(`config ${key} is required but missing`)
  }
}

const playerMap: {
  [bgaName: string]: string
} = {}

for (const key in process.env) {
  if (/^PLAYER_\d+_BGA_NAME/.test(key)) {
    const playerNo = Number(/^PLAYER_\d+/.exec(key)[0].split('_')[1])
    playerMap[process.env[key]] = process.env[`PLAYER_${playerNo}_WECHAT_ID`]
  }
}

export const config = {
  ...requiredConfig,
  ...optionalConfig,
  playerMap,
} as const