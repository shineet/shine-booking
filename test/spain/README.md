# Spain page tests

Drives the real `spain.html` in jsdom against a stub of the booking API, so the
plan, the money split and the settlement are exercised as a browser runs them
rather than as a reimplementation of them in a test.

    cd test/spain
    npm install jsdom
    node drive.js

`drive.js` starts `stub.js` itself. It refuses to run if something is already
listening on 8412, because a stale stub from an earlier run keeps its state and
turns the results into fiction.

It has earned its keep twice: it caught a settlement that balanced by summing to
zero when a creditor should receive their net, and it failed the day the cost
button was removed from informational rows, which was a stale expectation rather
than a bug but would otherwise have been noticed by nobody.
