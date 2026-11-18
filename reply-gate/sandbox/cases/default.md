# Default test replies

Every case is a `## Heading`, optional `@key: value` lines, then the reply
body exactly as a prospect would have typed it.

Keys: `@email @first_name @last_name @company @website @subject @offer
@auto_reply @expect @note`. All optional. `@expect` is the bucket you think
should come out (or `held` / `skipped`) — the run marks ✓ / ✗ against it.

Add your own cases at the bottom, or copy this file and pass
`--cases cases/yours.md`.

---

## Straight yes
@email: sean@acmeplumbing.example
@first_name: Sean
@company: Acme Plumbing
@website: acmeplumbing.example
@expect: positive_interested
Sounds great, let's do it. When are you free?

## Yes, terse
@email: mchen@brightpathdental.example
@first_name: Michael
@company: Brightpath Dental
@website: brightpathdental.example
@expect: positive_interested
Yes.

## Yes with a bit of doubt
@email: dana@meridianlogistics.example
@first_name: Dana
@company: Meridian Logistics
@website: meridianlogistics.example
@expect: positive_interested
Happy to have a chat. We've tried cold email before and it went nowhere, but if you can actually do it done-for-you I'll listen. Send some times over.

## Tell me more, clearly wants a call
@email: rob.hayes@summitroofingco.example
@first_name: Rob
@company: Summit Roofing Co
@website: summitroofingco.example
@expect: positive_interested
Interested. Tell me more and let's get something on the calendar.

## Yes, with our email quoted underneath
@email: sam@oversoulmedia.example
@first_name: Sam
@company: Oversoul Media
@website: oversoulmedia.example
@expect: positive_interested
@note: The quoted thread contains our own Calendly link. Must not trip the do-not-reply rule.
let's do it

On Mon, Aug 24, 2026 at 9:01 AM Alex <you@yourcompany.example> wrote:
> Hey Sam,
> I install an AI cold email system that books qualified sales calls ~ done-for-you.
> Also including mine - https://calendly.com/your-name/30min

## Price, direct
@email: pcastillo@northstarhvac.example
@first_name: Priya
@company: Northstar HVAC
@website: northstarhvac.example
@expect: positive_price
How much does this cost?

## Price, with a qualifier
@email: t.walsh@walshfinancialgroup.example
@first_name: Tom
@company: Walsh Financial Group
@website: walshfinancialgroup.example
@expect: positive_price
What are your rates? We're a small shop so if it's five figures a month this is a non starter.

## Price, phrased as budget
@email: alexis@vireodesign.example
@first_name: Alexis
@company: Vireo Design
@website: vireodesign.example
@expect: positive_price
Depends what the investment looks like. What sort of budget are we talking?

## Send me more info
@email: jgrant@keystonelegal.example
@first_name: Jordan
@company: Keystone Legal
@website: keystonelegal.example
@expect: positive_soft_info
Can you send me more info on how this actually works?

## Do you have a deck
@email: nsimmons@harborviewcapital.example
@first_name: Nina
@company: Harborview Capital
@website: harborviewcapital.example
@expect: positive_soft_info
Do you have a deck or some case studies I could look at first?

## Info request, no commitment language
@email: marcus@ridgelinefitness.example
@first_name: Marcus
@company: Ridgeline Fitness
@website: ridgelinefitness.example
@expect: positive_soft_info
What exactly do you do? Not sure I follow from the email.

## Circle back in Q3
@email: elena.ruiz@paloverdefoods.example
@first_name: Elena
@company: Palo Verde Foods
@website: paloverdefoods.example
@expect: positive_soft_later
We're heads down on a launch until Q3. Reach out then and we can talk.

## Not until September
@email: dwhitfield@whitfieldconstruction.example
@first_name: Derek
@company: Whitfield Construction
@website: whitfieldconstruction.example
@expect: positive_soft_later
Timing isn't right, we're mid-season. Check back in September.

## Clean referral
@email: kbarnes@lakeshoreortho.example
@first_name: Kate
@company: Lakeshore Ortho
@website: lakeshoreortho.example
@expect: positive_referral
That's not me. Maria runs sales here, she'd be the one to talk to.

## Tangled referral
@email: sfoster@fosterbrothersllc.example
@first_name: Steve
@company: Foster Brothers LLC
@website: fosterbrothersllc.example
@expect: other
@note: Two businesses and a condition attached. Should not get the clean-handoff template.
Not for this business but I also own a landscaping company that might be a fit, depending on price. My brother handles marketing over there, I'd have to check with him first.

## Where did you get my email
@email: acole@fairwaydentalgroup.example
@first_name: Aaron
@company: Fairway Dental Group
@website: fairwaydentalgroup.example
@expect: neutral_question
Where did you get my email address?

## Do you work with UK companies
@email: lbennett@corvusanalytics.example
@first_name: Laura
@company: Corvus Analytics
@website: corvusanalytics.example
@expect: neutral_question
Do you work with companies outside the US? We're UK based.

## Are we too small
@email: owner@thirdstreetbakery.example
@first_name: Rosa
@company: Third Street Bakery
@website: thirdstreetbakery.example
@expect: neutral_question
We're a three person shop. Is that too small for what you do?

## Flat no
@email: bill@tristateelectric.example
@first_name: Bill
@company: Tristate Electric
@website: tristateelectric.example
@expect: negative_notfit
Not interested.

## Already have an agency
@email: jkim@apexwealthadvisors.example
@first_name: Jenny
@company: Apex Wealth Advisors
@website: apexwealthadvisors.example
@expect: negative_notfit
We already have an agency doing this for us. Thanks anyway.

## Not now
@email: pmurphy@murphyandsonshvac.example
@first_name: Patrick
@company: Murphy and Sons HVAC
@website: murphyandsonshvac.example
@expect: negative_notnow
Bad timing, we're not looking at anything new this year.

## Hostile
@email: dgreene@greenepartners.example
@first_name: David
@company: Greene Partners
@website: greenepartners.example
@expect: negative_hostile
Stop spamming me. I never asked to hear from you and I'm reporting this as spam.

## Out of office
@email: swong@cascadeortho.example
@first_name: Susan
@company: Cascade Ortho
@website: cascadeortho.example
@subject: Automatic reply: quick question
@expect: skipped
I am out of the office until Monday, September 8th with limited access to email. For urgent matters contact reception.

## Bounce
@email: postmaster@defunctdomain.example
@subject: Undeliverable: quick question
@expect: skipped
Delivery has failed to these recipients or groups. The mailbox is unavailable.

## Unsubscribe
@email: rdavies@daviesgroup.example
@first_name: Rachel
@company: Davies Group
@website: daviesgroup.example
@expect: skipped
Please remove me from your list.

## Interested but mentions unsubscribing
@email: gpatel@patelortho.example
@first_name: Gita
@company: Patel Ortho
@website: patelortho.example
@expect: positive_soft_info
@note: The word "unsubscribe" appears but this is a real reply. The noise filter only skips short messages, so this must survive it.
Normally I unsubscribe from these things immediately, but this one actually caught my attention. We've been trying to figure out outbound for about a year and never got it off the ground. We do commercial orthodontic supply, mostly selling into practices across the midwest. Before I take up your time I'd want to understand what the system actually consists of and what you need from us to run it.

## They sent their own calendar link
@email: cmorgan@morganadvisory.example
@first_name: Chris
@company: Morgan Advisory
@website: morganadvisory.example
@expect: held
@note: Do-not-reply rule. You book in THEIR calendar and replies by hand.
Sure, grab a time that works: https://calendly.com/chris-morgan/30min

## They propose their own specific time
@email: aokafor@brightlinemedical.example
@first_name: Amara
@company: Brightline Medical
@website: brightlinemedical.example
@expect: positive_owntime
@note: Accept their time no matter what and promise the Google Meet invite. You send the actual invite yourself.
Can you do Thursday at 2pm eastern?

## Own time, casual phrasing
@email: jt@blueharborroofing.example
@first_name: JT
@company: Blue Harbor Roofing
@website: blueharborroofing.example
@expect: positive_owntime
Yes, how is 3pm on monday?

## Vague "next week" is NOT an own-time proposal
@email: fmoreau@moreauconsulting.example
@first_name: Felix
@company: Moreau Consulting
@website: moreauconsulting.example
@expect: positive_interested
@note: No specific time given, so the two-slots template is the right one, not the accept-their-time template.
Sure, sometime next week could work. What do you have?

## Reply from a different person than the lead
@email: rachel@theswellscore.example
@first_name: Rachel
@company: The Swell Score
@website: theswellscore.example
@expect: held
@note: The real case that the verifier caught in production. The greeting would say "Hi Rachel" but Terry wrote it.
Hi, this is Terry, Rachel's partner. She forwarded this to me. What's involved on our end?

## Asks to be texted
@email: kendall@organicmarketing.example
@first_name: Kendall
@company: Organic Marketing
@website: organicmarketing.example
@expect: other
Text me 555-0142

## Several asks at once
@email: mvasquez@vasquezautogroup.example
@first_name: Miguel
@company: Vasquez Auto Group
@website: vasquezautogroup.example
@expect: other
Couple things. What's the price, do you have references in automotive, can you sign an NDA, and who else at your company would be working on this? Also we'd need this reviewed by legal before anything starts.

## Who is this
@email: sbrennan@brennanindustrial.example
@first_name: Sean
@company: Brennan Industrial
@website: brennanindustrial.example
@expect: other
Who is this?

## Yes, but we don't know their first name
@email: info@harlowinteriors.example
@company: Harlow Interiors
@website: harlowinteriors.example
@expect: positive_interested
@note: No first name on the lead, so the greeting degrades to a bare "Hi" and the name check is skipped.
Sounds good, we're interested. What times do you have?
