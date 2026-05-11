# Using Passkeys in Browser Automation

When `zuul get <service>` returns a `passkey:` field, the value is a base64-encoded JSON blob containing a WebAuthn credential. Load it into a virtual authenticator before navigating to the login page.

## Decode the blob

```js
const credential = JSON.parse(Buffer.from(passkey, 'base64').toString());
```

## Field mapping

| Zuul blob field | CDP `addCredential` parameter |
|---|---|
| `credentialId` | `credentialId` |
| `privateKey` | `privateKey` |
| `rpId` | `rpId` |
| `userHandle` | `userHandle` |
| `isResidentCredential` | `isResidentCredential` |
| `signCount` | use `0` (see note below) |

## Sign count note

The `signCount` in the stored blob becomes stale after each login because the service increments it. Pass `signCount: 0` to `addCredential` to disable counter enforcement — this is the correct approach for bot use.

## Playwright

```js
const { chromium } = require('playwright');

async function loginWithPasskey(url, passkeyBlob) {
  const credential = JSON.parse(Buffer.from(passkeyBlob, 'base64').toString());

  const browser = await chromium.launch();
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);

  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: credential.credentialId,
      privateKey: credential.privateKey,
      rpId: credential.rpId,
      userHandle: credential.userHandle ?? '',
      isResidentCredential: credential.isResidentCredential ?? true,
      signCount: 0,
    },
  });

  await page.goto(url);
  // The browser will now use the virtual authenticator when the site triggers WebAuthn
}
```

## Puppeteer

```js
const puppeteer = require('puppeteer');

async function loginWithPasskey(url, passkeyBlob) {
  const credential = JSON.parse(Buffer.from(passkeyBlob, 'base64').toString());

  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  const cdp = await page.createCDPSession();

  await cdp.send('WebAuthn.enable', { enableUI: false });
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
    },
  });

  await cdp.send('WebAuthn.addCredential', {
    authenticatorId,
    credential: {
      credentialId: credential.credentialId,
      privateKey: credential.privateKey,
      rpId: credential.rpId,
      userHandle: credential.userHandle ?? '',
      isResidentCredential: credential.isResidentCredential ?? true,
      signCount: 0,
    },
  });

  await page.goto(url);
}
```

## Selenium (Chromium)

Selenium's WebAuthn support uses the same CDP protocol when driving Chromium via ChromeDriver.

```python
from selenium import webdriver
from selenium.webdriver.chrome.options import Options
import json, base64

def login_with_passkey(url, passkey_blob):
    credential = json.loads(base64.b64decode(passkey_blob))

    options = Options()
    driver = webdriver.Chrome(options=options)

    driver.execute_cdp_cmd('WebAuthn.enable', {'enableUI': False})
    result = driver.execute_cdp_cmd('WebAuthn.addVirtualAuthenticator', {
        'options': {
            'protocol': 'ctap2',
            'transport': 'internal',
            'hasResidentKey': True,
            'hasUserVerification': True,
            'isUserVerified': True,
        }
    })
    authenticator_id = result['authenticatorId']

    driver.execute_cdp_cmd('WebAuthn.addCredential', {
        'authenticatorId': authenticator_id,
        'credential': {
            'credentialId': credential['credentialId'],
            'privateKey': credential['privateKey'],
            'rpId': credential['rpId'],
            'userHandle': credential.get('userHandle', ''),
            'isResidentCredential': credential.get('isResidentCredential', True),
            'signCount': 0,
        }
    })

    driver.get(url)
```

Note: Selenium WebAuthn CDP support requires ChromeDriver 115+ and is less well-documented than Playwright/Puppeteer. If you encounter issues, Playwright is the more reliable choice.
