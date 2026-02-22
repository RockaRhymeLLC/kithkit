# Soccer Factory Schedule Checker

Check class availability and book sessions at The Soccer Factory (Forest Hill, MD) for Gabe's training.

## Facility Info

- **Name**: The Soccer Factory
- **Address**: 98 Industry Lane, Forest Hill, MD 21050
- **Phone**: (443) 966-2250
- **Email**: admin@soccerfactorymd.com
- **Hours**: Mon-Fri 4-10 PM, Sat-Sun 9 AM - 7 PM
- **Booking System**: Acuity Scheduling (thesoccerfactory.as.me)

## Gabe's Membership

- **Class**: Advanced (8pm)
- **Membership**: Active monthly plan — 2 classes/week (Mon-Thu) + Friday scrimmage
- **Subscription**: Auto-renews on the 19th each month (~$160/cycle = 4 sessions). Code may change each renewal — always use "VIEW YOUR REDEEMABLE CODES" to get the current one
- **Registration pattern**: Book 1-2 weeks in advance
- **Scheduling**: Work around Gabe's other after-school activities (practices, games, etc.)

## Workflow

When Dave asks about Soccer Factory availability:

1. **Check the Acuity calendar** for Advanced 8pm open slots over the next 1-2 weeks
2. **Check Dave's calendar** for Gabe's other activities (practices, games, etc.)
3. **Suggest the best 2 sessions** (Mon-Thu) that don't conflict with other commitments
4. **Note Friday scrimmage** availability if applicable
5. **Book the sessions** if Dave confirms (requires login — see Book a Session below)

## Check Availability

Use Playwright to check the schedule:

1. Open the Group Training booking page:
   ```
   playwright-cli open "https://thesoccerfactory.as.me/schedule/0ca3ee8a/?categories%5B%5D=Group%20Training&template=monthly"
   ```

2. Find **"Advanced - (8pm)"** in the session list and click its **"Book"** button

3. The calendar view shows available dates:
   - Clickable dates = sessions available (with spots remaining)
   - Disabled/greyed dates = no availability
   - Sessions typically run Mon-Thu

4. Navigate months with Previous/Next month buttons to check the requested time period

5. Click a specific date to see the time slot and how many spots are left

6. Report back with:
   - Which dates have Advanced 8pm sessions available
   - How many spots remain on each date
   - Any conflicts with Gabe's other activities
   - Recommended 2 sessions for the week

## Book a Session

Use Playwright to book through the Acuity member portal:

1. Open the Group Training booking page (same as availability check):
   ```
   playwright-cli open "https://thesoccerfactory.as.me/schedule/0ca3ee8a/?categories%5B%5D=Group%20Training&template=monthly"
   ```

2. Click **"Login"** button in the upper right corner

3. Log in with credentials from Keychain:
   - Email: `credential-soccer-factory-email`
   - Password: `credential-soccer-factory-password`

4. Find **"Advanced - (8pm)"** and click **"Book"**

5. Select the first date on the calendar, click the **"8:00 PM / X spots left"** time slot

6. For booking 2 sessions in one week:
   - Click **"Select and add another time"** on the first session
   - Pick the second date, click the time slot
   - Click **"Select and continue"** on the second session

7. For booking a single session:
   - Click **"Select and continue"**

8. On the confirmation page:
   - All personal/medical info is pre-filled (logged-in member)
   - Scroll down past the waivers and terms text
   - Check **"I have read and agree to the terms above"** checkbox
   - Click **"CONTINUE TO PAYMENT"**

9. On the payment page (Order summary shows $40.00):
   - Click **"VIEW YOUR REDEEMABLE CODES >"** to open the codes modal
   - The modal shows the active subscription with remaining balance and code
   - Click **"APPLY"** next to the subscription code to redeem it
   - Verify the total drops to $0.00
   - Click **"PAY & CONFIRM"**

10. Confirm booking success and report back to Dave

**Important**: If the redeemable codes modal shows $0 remaining or the subscription has expired, STOP and notify Dave — the membership may need renewal.

## Notes

- The calendar sometimes shows entire months as unavailable — this may mean sessions are full, not yet opened, or there's a break
- If the online calendar looks wrong, suggest Dave call (443) 966-2250 to confirm
- Drop-ins are $40/session for non-members; free for members with a booking code
- Gabe usually does Mon and Thu 8pm, but flex around other activities
- **Avoid Wednesdays** — family night, keep that evening free
- Preferred days: Mon, Tue, Thu (in that order, avoiding Wed)
