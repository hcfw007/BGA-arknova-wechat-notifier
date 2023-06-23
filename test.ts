import puppeteer from "puppeteer"

(async function () {
  const browser = await puppeteer.launch({
    headless: false // debug usage
  })
  
  const page = await browser.newPage()
  
  await page.goto('https://www.baidu.com')
})()

