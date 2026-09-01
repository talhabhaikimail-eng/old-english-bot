import puppeteer from 'puppeteer-core';

/**
 * Automates Google account sign-in inside the running Chromium container.
 * Connects via CDP on the given host port (socat-bridged).
 * Returns true on success, false on failure.
 */
export async function signIntoGoogle(cdpPort: number): Promise<boolean> {
  const email = process.env.BROWSER_GOOGLE_SIGN_IN_EMAIL;
  const password = process.env.BROWSER_GOOGLE_SIGN_IN_PASSWORD;

  if (!email || !password) {
    console.log('[Google Sign-In] Email or password not provided in env — skipping.');
    return false;
  }

  let browser;
  let page;

  try {
    console.log(`[Google Sign-In] Connecting to browser CDP on port ${cdpPort}...`);
    browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${cdpPort}` });
    page = await browser.newPage();

    // 1. Hide webdriver signature to bypass anti-bot detection
    await page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => undefined,
      });
    });

    // 2. Set natural desktop viewport and User-Agent
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
    });

    console.log('[Google Sign-In] Navigating to Google Sign-In page...');
    await page.goto('https://accounts.google.com/signin', { waitUntil: 'networkidle2' });

    // 3. Fill email
    console.log('[Google Sign-In] Waiting for email input field...');
    await page.waitForSelector('input[type="email"]', { visible: true, timeout: 20000 });
    await new Promise(r => setTimeout(r, 1000));
    
    // Human-like: Click field to focus before typing
    await page.click('input[type="email"]');
    await new Promise(r => setTimeout(r, 300));
    await page.type('input[type="email"]', email, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    // Submit email: Click "Next" button or press Enter
    const emailNextButton = await page.$('#identifierNext button');
    if (emailNextButton) {
      console.log('[Google Sign-In] Clicking email Next button...');
      await emailNextButton.click();
    } else {
      console.log('[Google Sign-In] Pressing Enter for email...');
      await page.keyboard.press('Enter');
    }

    // 4. Wait for password field (Google has an animated transition)
    console.log('[Google Sign-In] Waiting for password field...');
    await page.waitForSelector('input[type="password"]', { visible: true, timeout: 25000 });
    await new Promise(r => setTimeout(r, 1500));

    // Human-like: Click field to focus before typing
    await page.click('input[type="password"]');
    await new Promise(r => setTimeout(r, 300));
    await page.type('input[type="password"]', password, { delay: 80 });
    await new Promise(r => setTimeout(r, 500));

    // Submit password: Click "Next" button or press Enter
    const passwordNextButton = await page.$('#passwordNext button');
    if (passwordNextButton) {
      console.log('[Google Sign-In] Clicking password Next button...');
      await passwordNextButton.click();
    } else {
      console.log('[Google Sign-In] Pressing Enter for password...');
      await page.keyboard.press('Enter');
    }

    // Wait for initial navigation
    console.log('[Google Sign-In] Waiting for sign-in process...');
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });

    // 5. Detect and handle "Confirm your recovery email" challenges
    try {
      await new Promise(r => setTimeout(r, 3000));
      const challengeNeeded = await page.evaluate(() => {
        const text = document.body.innerText;
        return text.includes('Confirm your recovery email') ||
               text.includes('Verify it\'s you') ||
               !!document.querySelector('div[data-challengetype="12"]') ||
               !!document.querySelector('input#knowledge-prereq-email-response');
      });

      if (challengeNeeded) {
        console.log('[Google Sign-In] 🛡️ Security challenge / recovery email screen detected!');
        const recoveryEmail = process.env.BROWSER_GOOGLE_SIGN_IN_RECOVERY || 'haramikuta104@gmail.com';

        // Click the recovery email option if listed
        const recoveryOption = await page.$('div[data-challengetype="12"]');
        if (recoveryOption) {
          console.log('[Google Sign-In] Clicking recovery email option...');
          await recoveryOption.click();
          await new Promise(r => setTimeout(r, 2000));
        }

        // Check if the recovery input field is present
        const recoveryInput = await page.$('input[type="email"], input#knowledge-prereq-email-response');
        if (recoveryInput) {
          console.log('[Google Sign-In] Entering recovery email...');
          await recoveryInput.click();
          await new Promise(r => setTimeout(r, 300));
          await recoveryInput.type(recoveryEmail, { delay: 80 });
          await new Promise(r => setTimeout(r, 500));
          await page.keyboard.press('Enter');
          console.log('[Google Sign-In] Recovery email submitted.');
          await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => { });
        }
      }
    } catch (challengeErr) {
      console.log('[Google Sign-In] (Info) No security challenge page encountered.');
    }

    // Confirm we are no longer on any sign-in page
    const finalUrl = page.url();
    const success = !finalUrl.includes('accounts.google.com/signin');

    if (success) {
      console.log(`[Google Sign-In] ✅ Signed in successfully. Current URL: ${finalUrl}`);
    } else {
      console.warn(`[Google Sign-In] ⚠️ Sign-in may have failed or requires manual 2FA. Current URL: ${finalUrl}`);
    }

    return success;
  } catch (error) {
    console.error('[Google Sign-In] ❌ Failed:', error);
    return false;
  } finally {
    if (page) {
      try {
        await page.close();
      } catch (e) {
        // ignore leak
      }
    }
    if (browser) {
      try {
        browser.disconnect();
      } catch (e) {
        // ignore leak
      }
    }
  }
}
