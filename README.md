# My Feed

Jack's own social feed. Everything he follows in one place, with no algorithm, no ads and no arguments.

It refreshes itself every 30 minutes, works on phone and computer, and still shows your last feed when there's no signal.

## Putting it on your phone

- **iPhone:** open your feed's web address in Safari, tap the Share button, then **Add to Home Screen**.
- **Android:** open it in Chrome, tap the ⋮ menu, then **Add to Home screen** (or **Install app**).
- **Computer:** bookmark it. In Chrome or Edge you can also click the install icon in the address bar.

## Changing what you follow

Everything lives in **`feeds.json`**. Open it on GitHub, tap the pencil icon to edit, then press **Commit changes**. Your feed rebuilds itself in a minute or two.

- **Add a source:** copy one of the lines, then change the `name`, `url` and `tab`.
- **Remove a source:** delete its line, and check the line before it still ends with a comma (except the very last one).
- **Follow any topic:** use a Google News search. Copy one of the `news.google.com` lines and change the words after `q=`, using `+` instead of spaces. For example `q=%22Shanti+Celeste%22` follows Shanti Celeste. (`%22` means a quote mark.)
- **Photos in the Pictures tab:** add `"pictures": true` to a source.
- **Fewer posts from a busy source:** add `"max": 10`.

Settings inside the app (the sliders button) let you mute words, choose which topics appear in **All**, and see if any source has stopped working.

## Refreshing straight away

Go to the **Actions** tab on GitHub, choose **Update my feed**, then **Run workflow**.

## Good to know

- Saved posts and muted words are kept on each device separately, so saving something on your phone won't show it on your laptop.
- Some sites occasionally block automatic readers. If a source shows red in Settings for a few days, swap it for a Google News search on the same topic.
- Wordle opens the official New York Times page. The button turns grey with a tick once you've played that day.
