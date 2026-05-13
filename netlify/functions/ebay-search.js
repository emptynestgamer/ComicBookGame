// netlify/functions/ebay-search.js
// eBay Browse API proxy for ComicBookGame.com
// Keys are read from Netlify environment variables — never exposed to the client.
//
// Netlify Environment Variables required:
//   EBAY_APP_ID  — your App ID (Client ID)
//   EBAY_CERT_ID — your Cert ID (Client Secret)

const EBAY_TOKEN_URL  = ‘https://api.ebay.com/identity/v1/oauth2/token’;
const EBAY_SEARCH_URL = ‘https://api.ebay.com/buy/browse/v1/item_summary/search’;
const COMICS_CATEGORY = ‘259104’;

// EPN affiliate campaign ID
const EPN_CAMPAIGN_ID  = '5339152803';
const EPN_AFFILIATE_URL = 'https://rover.ebay.com/rover/1/711-53200-19255-0/1?campid=' + EPN_CAMPAIGN_ID + '&toolid=10001&mpre=';


// Allowed origins
const ALLOWED_ORIGINS = [
‘https://comicbookgame.com’,
‘https://www.comicbookgame.com’,
‘https://holdmycomics.netlify.app’,
];

const SLAB_TERMS = ['cgc', 'cbcs', 'pgx', 'graded', 'slab'];


const ABBREVIATIONS = {
‘asm’:  ‘amazing spider-man’,
‘uxm’:  ‘uncanny x-men’,
‘ff’:   ‘fantastic four’,
‘nm’:   ‘new mutants’,
‘tec’:  ‘detective comics’,
‘bats’: ‘batman’,
‘supes’:‘superman’,
‘hulk’: ‘incredible hulk’,
‘im’:   ‘iron man’,
‘cap’:  ‘captain america’,
};

function normalizeQuery(raw) {
let q = raw.toLowerCase().trim();
for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
if (q.startsWith(abbr + ’ ‘) || q === abbr) {
q = q.replace(abbr, full);
break;
}
}
q = q.replace(/\s+(\d+)$/, ’ #$1’);
return q;
}

function affiliateUrl(listingUrl) {
if (!listingUrl) return ‘’;
return EPN_AFFILIATE_URL + encodeURIComponent(listingUrl);
}

async function getOAuthToken() {
const credentials = Buffer.from(
`${process.env.EBAY_APP_ID}:${process.env.EBAY_CERT_ID}`
).toString(‘base64’);
const res = await fetch(EBAY_TOKEN_URL, {
method: ‘POST’,
headers: {
‘Authorization’: `Basic ${credentials}`,
‘Content-Type’:  ‘application/x-www-form-urlencoded’,
},
body: ‘grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope’,
});
if (!res.ok) throw new Error(`Token fetch failed: ${res.status}`);
const data = await res.json();
return data.access_token;
}

function isSlabbed(title) {
const t = title.toLowerCase();
return SLAB_TERMS.some(term => t.includes(term));
}

function median(arr) {
if (!arr.length) return null;
const sorted = [...arr].sort((a, b) => a - b);
const mid = Math.floor(sorted.length / 2);
return sorted.length % 2 !== 0
? sorted[mid]
: (sorted[mid - 1] + sorted[mid]) / 2;
}

async function searchListings(token, query, limit = 12) {
const params = new URLSearchParams({
q:            query,
category_ids: COMICS_CATEGORY,
limit:        limit.toString(),
fieldgroups:  ‘MATCHING_ITEMS,EXTENDED’,
});
const res = await fetch(`${EBAY_SEARCH_URL}?${params}`, {
headers: {
‘Authorization’:           `Bearer ${token}`,
‘X-EBAY-C-MARKETPLACE-ID’: ‘EBAY_US’,
‘Content-Type’:            ‘application/json’,
},
});
if (!res.ok) return [];
const data = await res.json();
return data.itemSummaries || [];
}

exports.handler = async (event) => {
const origin = event.headers?.origin || ‘’;
const allowedOrigin = ALLOWED_ORIGINS.includes(origin)
? origin
: ALLOWED_ORIGINS[0];

const headers = {
    'Access-Control-Allow-Origin':  allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
};

if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
}

const query = event.queryStringParameters?.q?.trim();
if (!query) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing search query' }) };
}

try {
    const normalizedQuery = normalizeQuery(query);
    const token = await getOAuthToken();
    const activeItems = await searchListings(token, normalizedQuery, 12);
    const rawItems = activeItems.filter(item => !isSlabbed(item.title || ''));

    if (!rawItems.length) {
        return { statusCode: 200, headers, body: JSON.stringify({ results: [], fmv: null, fmvSource: 'none' }) };
    }

    const activePrices = rawItems
        .map(item => parseFloat(item.price?.value))
        .filter(p => !isNaN(p) && p > 0);

    const fmv = median(activePrices);

    const results = rawItems.slice(0, 8).map(item => {
        const askingPrice = parseFloat(item.price?.value) || 0;
        const image       = item.image?.imageUrl || item.thumbnailImages?.[0]?.imageUrl || null;
        const pctDiff     = fmv ? ((askingPrice - fmv) / fmv) * 100 : 0;

        return {
            id:          item.itemId,
            title:       item.title,
            askingPrice: parseFloat(askingPrice.toFixed(2)),
            fmv:         fmv ? parseFloat(fmv.toFixed(2)) : null,
            pctDiff:     parseFloat(pctDiff.toFixed(1)),
            image,
            condition:   item.condition || 'Not Specified',
            seller:      item.seller?.username || '',
            listingUrl:  affiliateUrl(item.itemWebUrl || ''),
            fmvSource:   'active-median',
        };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ results, fmv, fmvSource: 'active-median' }) };

} catch (err) {
    console.error('ebay-search error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Search failed', detail: err.message }) };
}

};
