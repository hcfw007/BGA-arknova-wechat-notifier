const requiredConfig: Record<string, string> = {
  token: process.env.PADPLUS_TOKEN,
  endpoint: process.env.PADPLUS_ENDPOINT,
  workingRoomId: process.env.WORKING_ROOM_ID,
} 

const optionalConfig: Record<string, string> = {
  alarmReceiver: process.env.ALARM_CONTACT_ID,
}

for (const key in requiredConfig) {
  if (typeof requiredConfig[key] === 'undefined') {
    throw new Error(`config ${key} is required but missing`)
  }
}

export const config = {
  ...requiredConfig,
  ...optionalConfig,
}