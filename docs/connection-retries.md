# Connection attempts

This behavior is included in v0.3.0. Published v0.2.0 assets are unchanged and do not include these
retries. The browser flow requires the matching v0.3.0 gateway with cancellation support.

A connection you start retries temporary SSH/network failures three seconds after the failed attempt
has finished cleanup. Attempts do not overlap. Cancel stops the active handshake and removes the
retry timer; late authentication or trust replies cannot reconnect a cancelled operation.

Wrong passwords/passphrases, rejected host keys and permanent gateway policy failures pause for
correction. Verify the target/key or correct your credentials, then choose Connect again. Repeated
wrong credentials can trigger device-side account lockouts.

SSH authentication ends the retry operation. If the first diagnostic collection fails, the healthy
SSH connection and terminal remain available, with the last evidence retained and live collection
paused. A diagnostic or shell failure does not initiate another credential login. Reload, updater
restart and loss of an already-established connection still require an explicit Connect action.

The browser edition requires a gateway that advertises connection cancellation support. Older
gateways pause before opening SSH; update the gateway to use retries safely. If cleanup cannot be
confirmed after a lost gateway response, the app pauses rather than creating overlapping sessions.

Credentials remain in memory and are never included in retry status, URLs, logs, reports or browser
storage.
