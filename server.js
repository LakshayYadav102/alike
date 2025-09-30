const express = require('express');
const path = require('path');
const { chromium } = require('playwright');
const fs = require('fs');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

let running = false;
let browser;
let context;
let targetPage;
let emailPage;

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.post('/start', async (req, res) => {
  const targetUrl = req.body.url?.trim();
  if (!targetUrl) {
    console.error('No URL provided in request body:', req.body);
    return res.status(400).send('URL is required');
  }
  if (running) {
    return res.status(400).send('Process is already running.');
  }
  running = true;
  console.log('Starting process with URL:', targetUrl);
  startLiking(targetUrl).catch(err => {
    console.error('Error in liking process:', err);
    running = false;
  });
  res.send(`Started the liking process for ${targetUrl}. Check server logs for progress.`);
});

app.post('/stop', async (req, res) => {
  if (!running) {
    return res.send('Process is not running.');
  }
  running = false;
  try {
    if (context) await context.close();
    if (browser) await browser.close();
    console.log('Browser closed via stop request.');
  } catch (e) {
    console.warn('Error closing browser:', e.message);
  }
  res.send('Process stopped successfully.');
});

async function startLiking(targetUrl) {
  const TARGET_PAGE = targetUrl;
  const MAILNESIA_BASE = 'https://mailnesia.com/mailbox/';

  // CONFIG
  const ITERATIONS = 0;            // 0 for infinite loop
  const PERIOD_MS = 5_000;        // Wait between iterations
  const POLL_INTERVAL_MS = 2500;  // Poll email every 2.5s
  const POLL_TIMEOUT_MS = 120_000; // Max wait for OTP
  const HEADLESS = true;          // Set to true for server
  const NAV_TIMEOUT = 120000;     // Navigation timeout
  const SCREENSHOT_ON_ERROR = true; // Save screenshots on errors
  const MAX_RETRIES = 3;          // Retry on errors
  const BUTTON_WAIT_TIMEOUT = 40000; // Wait for buttons
  const EMAIL_CHANGE_RETRIES = 5; // Retries for email change
  const EMAIL_VISIBILITY_TIMEOUT = 20000; // Timeout for email visibility
  const CONTENT_LOAD_TIMEOUT = 30000; // Timeout for email content loading

  // Utility: sleep with random jitter
  const sleep = ms => new Promise(r => setTimeout(r, ms + Math.random() * 100));

  // Utility: Randomize user agent
  const getRandomUserAgent = () => {
    const userAgents = [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/117.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/116.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:109.0) Gecko/20100101 Firefox/117.0',
    ];
    return userAgents[Math.floor(Math.random() * userAgents.length)];
  };

  // Generate random username starting with 'lak' followed by 5 digits
  function generateUsername() {
    return 'lak' + Math.floor(Math.random() * 100000).toString().padStart(5, '0');
  }

  // Extract OTP from email content
  function extractOtp(text) {
    if (!text) return null;
    const m = text.match(/(?<!\d{4})\b(\d{4,8})\b(?!.*\d{4}-\d{2}-\d{2})/);
    return m ? m[1] : null;
  }

  // Save screenshot
  async function saveScreenshots(page, namePrefix) {
    try {
      if (!page || page.isClosed()) throw new Error('Page is closed');
      const timestamp = Date.now();
      const fname = `${namePrefix}-${timestamp}.png`;
      await page.screenshot({ path: fname, fullPage: true });
      console.log('Saved screenshot:', fname);
    } catch (e) {
      console.warn('Could not save screenshot:', e.message || e);
    }
  }

  // Save page HTML
  async function savePageContent(page, namePrefix) {
    try {
      if (!page || page.isClosed()) throw new Error('Page is closed');
      const timestamp = Date.now();
      const fname = `${namePrefix}-${timestamp}.html`;
      const content = await page.content();
      fs.writeFileSync(fname, content);
      console.log('Saved page content:', fname);
    } catch (e) {
      console.warn('Could not save page content:', e.message || e);
    }
  }

  // Log form content
  async function logFormContent(page) {
    try {
      if (!page || page.isClosed()) throw new Error('Page is closed');
      const form = await page.locator('form, div[class*="form" i], div[id*="form" i], div[class*="like-modal"]').innerHTML();
      console.log('Form content:', form);
    } catch (e) {
      console.warn('Could not log form content:', e.message || e);
    }
  }

  browser = await chromium.launch({ headless: HEADLESS });

  async function setupContextAndPages() {
    if (context) {
      try {
        await context.close();
      } catch (e) {
        console.warn('Error closing previous context:', e.message);
      }
    }
    context = await browser.newContext({
      userAgent: getRandomUserAgent(),
      extraHTTPHeaders: {
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      },
      storageState: { cookies: [] },
    });
    targetPage = await context.newPage();
    emailPage = await context.newPage();
    targetPage.setDefaultNavigationTimeout(NAV_TIMEOUT);
    emailPage.setDefaultNavigationTimeout(NAV_TIMEOUT);

    // Handle unexpected new pages (e.g., ads opening new tabs)
    context.on('page', async (newPage) => {
      const url = newPage.url();
      if (![targetPage, emailPage].includes(newPage) && url !== 'about:blank') {
        console.log(`Closing unexpected page: ${url || 'unknown'}`);
        await newPage.close().catch((e) => console.warn('Error closing page:', e.message));
      }
    });

    // Handle popups
    emailPage.on('popup', async (popup) => {
      console.log('Closing popup from email page');
      await popup.close().catch((e) => console.warn('Error closing popup:', e.message));
    });
    targetPage.on('popup', async (popup) => {
      console.log('Closing popup from target page');
      await popup.close().catch((e) => console.warn('Error closing popup:', e.message));
    });

    // Cancel downloads
    emailPage.on('download', async (download) => {
      console.log(`Cancelling download: ${download.url()}`);
      await download.cancel().catch((e) => console.warn('Error cancelling download:', e.message));
    });
    targetPage.on('download', async (download) => {
      console.log(`Cancelling download: ${download.url()}`);
      await download.cancel().catch((e) => console.warn('Error cancelling download:', e.message));
    });

    // Handle dialogs
    emailPage.on('dialog', async dialog => {
      console.log(`Dialog detected: ${dialog.message()} (Type: ${dialog.type()})`);
      if (dialog.type() === 'confirm') {
        await dialog.accept();
        console.log('Accepted confirm dialog');
      } else {
        await dialog.dismiss();
        console.log('Dismissed non-confirm dialog');
      }
    });

    // Log network errors
    targetPage.on('requestfailed', request => {
      if (!request.url().includes('google-analytics.com')) {
        console.log(`Target page request failed: ${request.url()} - ${request.failure()?.errorText}`);
      }
    });
    emailPage.on('requestfailed', request => {
      if (!request.url().includes('google-analytics.com')) {
        console.log(`Email page request failed: ${request.url()} - ${request.failure()?.errorText}`);
      }
    });
    targetPage.on('response', response => {
      if (response.status() === 403 || response.status() === 422 || response.status() === 429) {
        console.log(`${response.status()} on: ${response.url()}`);
      }
    });
    emailPage.on('response', response => {
      if (response.status() === 403 || response.status() === 422 || response.status() === 429) {
        console.log(`${response.status()} on: ${response.url()}`);
      }
    });
  }

  async function recreatePageIfRedirected(page, expectedUrl) {
    try {
      const currentUrl = page.url();
      if (currentUrl !== expectedUrl && currentUrl !== 'about:blank') {
        console.log(`Detected redirect to ad (${currentUrl}), recreating page...`);
        await page.close().catch((e) => console.warn('Error closing page:', e.message));
        page = await context.newPage();
        page.setDefaultNavigationTimeout(NAV_TIMEOUT);
        page.on('popup', async (popup) => {
          console.log('Closing popup');
          await popup.close().catch((e) => console.warn('Error closing popup:', e.message));
        });
        page.on('download', async (download) => {
          console.log(`Cancelling download: ${download.url()}`);
          await download.cancel().catch((e) => console.warn('Error cancelling download:', e.message));
        });
        page.on('dialog', async dialog => {
          console.log(`Dialog detected: ${dialog.message()} (Type: ${dialog.type()})`);
          if (dialog.type() === 'confirm') {
            await dialog.accept();
            console.log('Accepted confirm dialog');
          } else {
            await dialog.dismiss();
            console.log('Dismissed non-confirm dialog');
          }
        });
        page.on('requestfailed', request => {
          if (!request.url().includes('google-analytics.com')) {
            console.log(`Page request failed: ${request.url()} - ${request.failure()?.errorText}`);
          }
        });
        page.on('response', response => {
          if (response.status() === 403 || response.status() === 422 || response.status() === 429) {
            console.log(`${response.status()} on: ${response.url()}`);
          }
        });
        await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await sleep(2000);
      }
    } catch (e) {
      console.warn('Error in recreatePageIfRedirected:', e.message);
      await page.close().catch(() => {});
      page = await context.newPage();
      page.setDefaultNavigationTimeout(NAV_TIMEOUT);
      await page.goto(expectedUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await sleep(2000);
    }
    return page;
  }

  async function getEmailAddress(emailPage, previousUsername = null) {
    let retryCount = 0;
    while (retryCount < EMAIL_CHANGE_RETRIES && running) {
      try {
        let username;
        do {
          username = generateUsername();
        } while (username === previousUsername);

        const url = MAILNESIA_BASE + username;
        await emailPage.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await sleep(2000);
        emailPage = await recreatePageIfRedirected(emailPage, url);
        await savePageContent(emailPage, `debug-email-before-fetch-iteration-${retryCount}`);
        const email = username + '@mailnesia.com';
        console.log(`Generated email: ${email}`);
        return { email, username };
      } catch (e) {
        console.error('Error getting email address:', e.message);
        await saveScreenshots(emailPage, 'error-email-get');
        retryCount++;
        if (retryCount < EMAIL_CHANGE_RETRIES && running) {
          console.log(`Retrying email fetch (${retryCount + 1}/${EMAIL_CHANGE_RETRIES})...`);
          await sleep(2000);
          continue;
        }
        throw e;
      }
    }
    throw new Error('Max retries reached for email fetch or stopped');
  }

  async function pollForOtp(emailPage, username, timeoutMs = POLL_TIMEOUT_MS) {
    const start = Date.now();
    const mailboxUrl = MAILNESIA_BASE + username;
    let pollRetryCount = 0;
    const MAX_POLL_RETRIES = 5;

    while (Date.now() - start < timeoutMs && pollRetryCount < MAX_POLL_RETRIES && running) {
      try {
        if (emailPage.isClosed()) {
          console.log('Email page closed, recreating...');
          emailPage = await context.newPage();
          emailPage.setDefaultNavigationTimeout(NAV_TIMEOUT);
          emailPage.on('popup', async (popup) => {
            console.log('Closing popup');
            await popup.close().catch((e) => console.warn('Error closing popup:', e.message));
          });
          emailPage.on('download', async (download) => {
            console.log(`Cancelling download: ${download.url()}`);
            await download.cancel().catch((e) => console.warn('Error cancelling download:', e.message));
          });
          emailPage.on('dialog', async dialog => {
            console.log(`Dialog detected: ${dialog.message()} (Type: ${dialog.type()})`);
            if (dialog.type() === 'confirm') {
              await dialog.accept();
              console.log('Accepted confirm dialog');
            } else {
              await dialog.dismiss();
              console.log('Dismissed non-confirm dialog');
            }
          });
          emailPage.on('requestfailed', request => {
            if (!request.url().includes('google-analytics.com')) {
              console.log(`Page request failed: ${request.url()} - ${request.failure()?.errorText}`);
            }
          });
          emailPage.on('response', response => {
            if (response.status() === 403 || response.status() === 422 || response.status() === 429) {
              console.log(`${response.status()} on: ${response.url()}`);
            }
          });
        }

        await emailPage.goto(mailboxUrl, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await sleep(2000);
        emailPage = await recreatePageIfRedirected(emailPage, mailboxUrl);
        console.log('Opened mailbox page');

        const rowSelector = 'tr.emailheader';
        const rows = await emailPage.locator(rowSelector).all();
        if (rows.length === 0) {
          console.log('No messages found yet...');
          await sleep(POLL_INTERVAL_MS);
          continue;
        }

        let targetRow = null;
        for (const row of rows) {
          const tds = await row.locator('td').all();
          const senderText = await tds[1].textContent() || '';
          const subjectText = await tds[3].textContent() || '';
          console.log(`Checking email - Sender: ${senderText}, Subject: ${subjectText}`);
          if (
            senderText.toLowerCase().includes('startup nation') ||
            senderText.includes('info@startupnationindia.com') ||
            subjectText.toLowerCase().includes('verification code for startup like')
          ) {
            targetRow = row;
            console.log('Found Startup Nation email');
            break;
          }
        }
        if (!targetRow) {
          console.log('No Startup Nation email found, trying most recent...');
          targetRow = rows[0];
        }

        const linkLocator = targetRow.locator('a.email').first();
        const href = await linkLocator.getAttribute('href');
        if (!href) {
          console.log('No href found, skipping...');
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const fullLink = `https://mailnesia.com${href}`;
        console.log('Opening email in new tab:', fullLink);

        let contentPage = await context.newPage();
        contentPage.setDefaultNavigationTimeout(NAV_TIMEOUT);
        try {
          await contentPage.goto(fullLink, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
          await sleep(2000);
          contentPage = await recreatePageIfRedirected(contentPage, fullLink);
          await savePageContent(contentPage, `debug-email-content-${Date.now()}`);

          const bodySelector = 'div.pill-content strong';
          await contentPage.waitForSelector(bodySelector, { state: 'visible', timeout: CONTENT_LOAD_TIMEOUT });
          let otp = await contentPage.locator(bodySelector).textContent({ timeout: CONTENT_LOAD_TIMEOUT });
          otp = otp ? otp.trim() : null;

          if (!otp) {
            const fullText = await contentPage.locator('div.pill-content').textContent({ timeout: CONTENT_LOAD_TIMEOUT });
            otp = extractOtp(fullText);
          }

          await contentPage.close();

          if (otp) {
            console.log('Extracted OTP:', otp);
            return otp;
          }
          console.log('No OTP in message, polling again...');
        } catch (e) {
          console.warn('Error in email content page:', e.message);
          await contentPage.close().catch(() => {});
          pollRetryCount++;
          if (pollRetryCount >= MAX_POLL_RETRIES) {
            throw new Error('Max poll retries reached for OTP fetch');
          }
        }
      } catch (e) {
        console.warn('Error polling for OTP:', e.message);
        if (e.message.includes('Target page, context or browser has been closed')) {
          console.log('Recreating context due to closure...');
          await setupContextAndPages();
        }
        pollRetryCount++;
        if (pollRetryCount >= MAX_POLL_RETRIES) {
          throw new Error('Max poll retries reached for OTP fetch');
        }
        await sleep(POLL_INTERVAL_MS);
        continue;
      }
      await sleep(POLL_INTERVAL_MS);
    }
    return null;
  }

  async function performLikeCycle(iterationIdx = 0, previousUsername = null) {
    let retryCount = 0;

    while (retryCount < MAX_RETRIES && running) {
      try {
        console.log(`\n=== ITERATION ${iterationIdx} (Attempt ${retryCount + 1}/${MAX_RETRIES}) ===`);
        await context.clearCookies();
        await savePageContent(targetPage, `debug-page-before-load-iteration-${iterationIdx}-attempt-${retryCount + 1}`);

        // Step 1: Get email
        await emailPage.bringToFront();
        const { email, username } = await getEmailAddress(emailPage, previousUsername);
        console.log('Generated/Retrieved email:', email);

        // Step 2: Go to Startup Nation page and click Like
        await targetPage.bringToFront();
        await targetPage.goto(TARGET_PAGE, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
        await sleep(3000);
        console.log('Target page URL:', targetPage.url());

        // Wait for buttons to load
        await targetPage.waitForSelector('button', { state: 'visible', timeout: BUTTON_WAIT_TIMEOUT });
        const buttons = await targetPage.locator('button').all();
        const buttonDetails = await Promise.all(
          buttons.map(async b => ({
            text: await b.textContent(),
            class: await b.getAttribute('class'),
            ariaLabel: await b.getAttribute('aria-label'),
          }))
        );
        console.log('Available buttons:', buttonDetails);

        const likeBtn = targetPage.locator('button.product-detail-like-btn[aria-label="Like"]');
        if (await likeBtn.count() === 0) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          throw new Error('Like button not found');
        }
        await likeBtn.first().waitFor({ state: 'visible', timeout: BUTTON_WAIT_TIMEOUT });
        await likeBtn.first().click();
        console.log('Clicked Like button');
        await sleep(500);

        // Step 3: Fill email
        const emailInput = targetPage.locator('input[type="email"], input[placeholder*="email" i], input[aria-label*="email" i]');
        if (await emailInput.count() === 0) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          await logFormContent(targetPage);
          throw new Error('Email input not found');
        }
        await emailInput.fill(email);
        console.log('Filled email:', email);
        await sleep(500);

        // Check for disposable error
        const errorExists = await targetPage.evaluate(() => {
          const selectors = ['div.like-modal-error', 'div.error-message', 'p.error', 'div.error', '.alert-error', '.validation-error'];
          for (const selector of selectors) {
            const elements = document.querySelectorAll(selector);
            for (const el of elements) {
              if (el.textContent.includes('Disposable email addresses are not allowed')) {
                return true;
              }
            }
          }
          return document.body.innerText.includes('Disposable email addresses are not allowed');
        });
        if (errorExists) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          await logFormContent(targetPage);
          throw new Error('Disposable email addresses are not allowed');
        }
        console.log('Email accepted, no disposable error');

        // Step 4: Submit email
        const submitBtn = targetPage.locator('button.like-modal-submit');
        if (await submitBtn.count() === 0) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          await logFormContent(targetPage);
          throw new Error('Submit button not found');
        }
        const isDisabled = await submitBtn.first().evaluate(el => el.hasAttribute('disabled'));
        if (isDisabled) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          await logFormContent(targetPage);
          throw new Error('Submit button is disabled');
        }
        await submitBtn.first().click();
        console.log('Submitted email, requesting OTP');
        await sleep(1000);

        // Step 5: Check for OTP
        await emailPage.bringToFront();
        const otp = await pollForOtp(emailPage, username);
        if (!otp) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          throw new Error('OTP not received within timeout');
        }

        // Step 6: Enter OTP
        await targetPage.bringToFront();
        const otpInput = targetPage.locator('input[type="text"], input[placeholder*="code" i], input[aria-label*="code" i]');
        if (await otpInput.count() === 0) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          throw new Error('OTP input not found');
        }
        await otpInput.fill(otp);
        console.log('Filled OTP:', otp);
        await sleep(500);

        // Step 7: Click Verify
        const verifyBtn = targetPage.locator('button.like-modal-submit:has-text("Verify & Like"), button[type="submit"]');
        if (await verifyBtn.count() === 0) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          throw new Error('Verify button not found');
        }
        await verifyBtn.first().waitFor({ state: 'visible', timeout: BUTTON_WAIT_TIMEOUT });
        const isVerifyDisabled = await verifyBtn.first().evaluate(el => el.hasAttribute('disabled'));
        console.log('Verify button disabled:', isVerifyDisabled);
        if (isVerifyDisabled) {
          await savePageContent(targetPage, `error-page-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          throw new Error('Verify button is disabled');
        }
        await verifyBtn.first().click();
        console.log('Clicked Verify button');
        await sleep(1000);

        console.log('Iteration success for', email);
        return { success: true, email, username };
      } catch (err) {
        console.error('Error in performLikeCycle:', err.message);
        if (SCREENSHOT_ON_ERROR) {
          try {
            await saveScreenshots(targetPage, `error-target-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
            await saveScreenshots(emailPage, `error-email-iteration-${iterationIdx}-attempt-${retryCount + 1}`);
          } catch (screenshotErr) {
            console.warn('Could not save screenshots:', screenshotErr.message);
          }
        }
        if ((err.message.includes('403') || err.message.includes('422') || err.message.includes('429') || err.message.includes('timeout') || err.message.includes('Disposable email') || err.message.includes('Submit button is disabled') || err.message.includes('Verify button is disabled') || err.message.includes('net::ERR_ABORTED') || err.message.includes('Target page, context or browser has been closed')) && retryCount < MAX_RETRIES - 1 && running) {
          console.log('Retrying due to error...');
          retryCount++;
          await setupContextAndPages();
          await sleep(2000 * Math.pow(2, retryCount));
          continue;
        }
        throw err;
      }
    }
    throw new Error('Max retries reached or stopped');
  }

  console.log('Starting automated like loop with Mailnesia.');
  let count = 0;
  let previousUsername = null;
  try {
    await setupContextAndPages();
    while (running && (ITERATIONS === 0 || count < ITERATIONS)) {
      count++;
      const ts = new Date().toISOString();
      console.log(`\n[${ts}] Starting iteration ${count}`);
      await targetPage.goto(TARGET_PAGE, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
      await sleep(3000);
      console.log('Refreshed Startup Nation page');
      const res = await performLikeCycle(count, previousUsername);
      console.log(`[${ts}] Result:`, res);
      if (res.success) {
        previousUsername = res.username;
      }
      await sleep(PERIOD_MS);
    }
  } catch (err) {
    console.error('Fatal error:', err.message);
  } finally {
    try {
      if (context) await context.close();
      if (browser) await browser.close();
    } catch (e) {
      console.warn('Error closing browser:', e.message);
    }
    console.log('Browser closed. Done.');
    running = false;
  }
}

app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});