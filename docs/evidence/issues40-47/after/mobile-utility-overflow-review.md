# Mobile map utility overflow review

An isolated local fixture exercised the collapsed and expanded search states with no page errors.

| Viewport | Toolbar | My map | Find places | Locate | Search | Result |
| --- | --- | --- | --- | --- | --- | --- |
| 320×844 | 10–310px | 15–100px | 104–205px | 209–253px | 261–305px | `scrollWidth` = `clientWidth` = 300px |
| 390×844 | 10–380px | 15–132px | 136–275px | 279–323px | 331–375px | `scrollWidth` = `clientWidth` = 370px |
| 1440×900 | 340–1100px | 347–451px | 455–566px | 588–634px | 642–688px | `scrollWidth` = `clientWidth` = 760px |

The dock reserves 96px for its two 44px controls and their 8px gap. Removing the obsolete third mode-grid column lets both mode buttons use the remaining space. Search expansion remains full-width.

Screenshots: `mobile-utility-320.png`, `mobile-utility-390.png`, and `mobile-utility-desktop.png`.
