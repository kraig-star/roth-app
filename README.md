# Roth Conversion Estimator

Simple static web app to compare Roth conversion scenarios and rank the top 3 by estimated lifetime tax savings.

## Files
- `index.html` - UI and form inputs
- `styles.css` - layout and visual styling
- `app.js` - strategy engine, retirement simulation, ranking logic

## Run Locally
You can open `index.html` directly in a browser, or serve this folder with any static host.

Example:
```bash
cd "/Users/kraigguffey/Documents/New project"
python3 -m http.server 8080
```

Then open: `http://localhost:8080`

## Strategy Configuration
Strategies are defined in `buildStrategyLibrary()` in `/Users/kraigguffey/Documents/New project/app.js`.

Implemented from your table:
- Pro-Rata
- Taxable, Tax-Deferred, Tax-Free
- Taxable, Tax-Free, Tax-Deferred
- Tax-Deferred, Taxable, Tax-Free
- Tax-Deferred, Tax-Free, Taxable
- Tax-Free, Tax-Deferred, Taxable
- Tax-Free, Taxable, Tax-Deferred
- Roth Conversions to fill 0%, 10%, 12%, 22%, 24%, 32%, 35% bracket
- Roth Conversions below IRMAA Brkt 1-5
- Maximum Roth Conversion

Conversion policy types currently supported:
- `none`
- `fillBracket`
- `belowIRMAA`
- `maximum`

## Current Inputs
- Qualified account balance
- Non-qualified account balance
- Tax-free account balance
- Current age
- Filing status
- Georgia state tax assumption is built in (5.39% effective)
- Optional current annual taxable income (pre-retirement, used for conversion timing)
- Retirement paycheck start age
- Life expectancy
- Optional birth year and optional RMD start age override
- Optional Social Security annual estimate + start age
- Optional annual paycheck override
- Optional advanced assumptions (returns, inflation, non-qualified taxable share)

## Output
- Top 3 strategies by tax savings vs baseline
- Best strategy featured
- Two data-driven reasons for best strategy
- Full results table for all scenarios
- Mobile-first, larger-font layout optimized for 55+ seminar attendees
- Shows `Net Income Increase`, `Net Legacy Increase`, and `Total Value Created` vs Pro-Rata
- IRMAA surcharge modeled with a 2-year MAGI lookback
- Values shown in today’s dollars (inflation-adjusted)
- Conversions can run in pre-retirement years (current age through retirement age)

## Important
This estimator is educational and simplified. It is not tax, legal, or investment advice.
