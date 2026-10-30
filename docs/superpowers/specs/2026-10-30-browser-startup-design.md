# Normal browser startup

The user selected correcting ParaBrowser startup so human browsing does not advertise WebDriver automation. Keep agent CDP connectivity, persistent browser profiles and explicit debugging flags working.

Use an OS-selected loopback port, pass its nonzero number to Chromium before app readiness, and resolve it from the main process command line. Continue verifying target ownership before pinning an endpoint. Fall back to DevToolsActivePort for explicit port zero. Preserve explicit port/pipe switches. Do not patch navigator or disable AutomationControlled.

Alternatives: retaining port zero reproduces webdriver=true; moving Google pages to external Chrome changes the requested browsing experience and is outside this fix. Google sign-in success remains an account-level manual check.
