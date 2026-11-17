# Reviewers and drafters read tiles and sheets, not whole boards

`render.cjs` writes each board three ways: the full-size PNG, 864x720 review tiles at 0.6 scale, and contact sheets of up to 8 boards per prefix. Delegates read the tiles and sheets, read each image once, and on a rescore read only the boards that changed. A full-size PNG is opened only to crop a named region.

An image over about 1568px on its long edge is shrunk on read. A 6,000px board read whole arrives about 320px wide, so its text is unreadable and the tokens buy nothing. A tile keeps text readable at about 830 image tokens, roughly a third of a 1440x900 shot per area. Every image stays in a delegate's context for every later turn, so reading fewer and smaller ones is most of the saving. The cost is that callout crops must map tile coordinates back to the full PNG, which the ticket drafter's agent file states.
