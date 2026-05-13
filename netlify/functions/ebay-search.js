// netlify/functions/ebay-search.js
// eBay Browse API proxy for ComicBookGame.com
// Netlify Environment Variables required:
//   EBAY_APP_ID  - your App ID (Client ID)
//   EBAY_CERT_ID - your Cert ID (Client Secret)

const EBAY_TOKEN_URL  = ‘https://api.ebay.com/identity/v1/oauth2/token’;
const EBAY_SEARCH_URL = ‘https://api.ebay.com/buy/browse/v1/item_summary/search’;
const COMICS_CATEGORY = ‘259104’;
const EPN_AFFILIATE_URL = ‘https://rover.ebay.com/rover/1/711-53200-19255-0/1?campid=5339152803&toolid=10001&mpre=’;

const ALLOWED_ORIGINS = [
‘https://comicbookgame.com’,
‘https://www.comicbookgame.com’,
‘https://holdmycomics.netlify.app’
];

const SLAB_TERMS = [‘cgc’, ‘cbcs’, ‘pgx’, ‘graded’, ‘slab’];

const ABBREVIATIONS = {
‘asm’:   ‘amazing spider-man’,
‘uxm’:   ‘uncanny x-men’,
‘ff’:    ‘fantastic four’,
‘nm’:    ‘new mutants’,
‘tec’:   ‘detective comics’,
‘bats’:  ‘batman’,
‘supes’: ‘superman’,
‘hulk’:  ‘incredible hulk’,
‘im’:    ‘iron man’,
‘cap’:   ‘captain america’
};

function normalizeQuery(raw) {
var q = raw.toLowerCase().trim();
var keys = Object.keys(ABBREVIATIONS);
for (var i = 0; i < keys.length; i++) {
var abbr = keys[i];
if (q.startsWith(abbr + ’ ‘) || q === abbr) {
q = q.replace(abbr, ABBREVIATIONS[abbr]);
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

function median(arr) {
if (!arr.length) return null;
var sorted = arr.slice().sort(function(a, b) { return a - b; });
var mid = Math.floor(sorted.length / 2);
if (sorted.length % 2 !== 0) {
return sorted[mid];
}
return (sorted[mid - 1] + sorted[mid]) / 2;
}

function isSlabbed(title) {
var t = title.toLowerCase();
for (var i = 0; i < SLAB_TERMS.length; i++) {
if (t.indexOf(SLAB_TERMS[i]) !== -1) return true;
}
return false;
}

async function getOAuthToken() {
var credentials = Buffer.from(
process.env.EBAY_APP_ID + ‘:’ + process.env.EBAY_CERT_ID
).toString(‘base64’);

var res = await fetch(EBAY_TOKEN_URL, {
    method: 'POST',
    headers: {
        'Authorization': 'Basic ' + credentials,
        'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: 'grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope'
});

if (!res.ok) throw new Error('Token fetch failed: ' + res.status);
var data = await res.json();
return data.access_token;

}

async function searchListings(token, query, limit) {
limit = limit || 12;
var params = new URLSearchParams({
q: query,
category_ids: COMICS_CATEGORY,
limit: String(limit),
fieldgroups: ‘MATCHING_ITEMS,EXTENDED’
});

var res = await fetch(EBAY_SEARCH_URL + '?' + params.toString(), {
    headers: {
        'Authorization': 'Bearer ' + token,
        'X-EBAY-C-MARKETPLACE-ID': 'EBAY_US',
        'Content-Type': 'application/json'
    }
});

if (!res.ok) return [];
var data = await res.json();
return data.itemSummaries || [];

}

exports.handler = async function(event) {
var origin = (event.headers && event.headers.origin) ? event.headers.origin : ‘’;
var allowedOrigin = ALLOWED_ORIGINS.indexOf(origin) !== -1 ? origin : ALLOWED_ORIGINS[0];

var headers = {
    'Access-Control-Allow-Origin': allowedOrigin,
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
};

if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: headers, body: '' };
}

var query = '';
if (event.queryStringParameters && event.queryStringParameters.q) {
    query = event.queryStringParameters.q.trim();
}

if (!query) {
    return { statusCode: 400, headers: headers, body: JSON.stringify({ error: 'Missing search query' }) };
}

try {
    var normalizedQuery = normalizeQuery(query);
    var token = await getOAuthToken();
    var activeItems = await searchListings(token, normalizedQuery, 12);
    var rawItems = activeItems.filter(function(item) {
        return !isSlabbed(item.title || '');
    });

    if (!rawItems.length) {
        return { statusCode: 200, headers: headers, body: JSON.stringify({ results: [], fmv: null, fmvSource: 'none' }) };
    }

    var activePrices = rawItems
        .map(function(item) { return parseFloat(item.price && item.price.value ? item.price.value : 0); })
        .filter(function(p) { return !isNaN(p) && p > 0; });

    var fmv = median(activePrices);

    var results = rawItems.slice(0, 8).map(function(item) {
        var askingPrice = parseFloat(item.price && item.price.value ? item.price.value : 0);
        var image = null;
        if (item.image && item.image.imageUrl) {
            image = item.image.imageUrl;
        } else if (item.thumbnailImages && item.thumbnailImages[0] && item.thumbnailImages[0].imageUrl) {
            image = item.thumbnailImages[0].imageUrl;
        }
        var pctDiff = fmv ? ((askingPrice - fmv) / fmv) * 100 : 0;

        return {
            id: item.itemId,
            title: item.title,
            askingPrice: parseFloat(askingPrice.toFixed(2)),
            fmv: fmv ? parseFloat(fmv.toFixed(2)) : null,
            pctDiff: parseFloat(pctDiff.toFixed(1)),
            image: image,
            condition: item.condition || 'Not Specified',
            seller: (item.seller && item.seller.username) ? item.seller.username : '',
            listingUrl: affiliateUrl(item.itemWebUrl || ''),
            fmvSource: 'active-median'
        };
    });

    return { statusCode: 200, headers: headers, body: JSON.stringify({ results: results, fmv: fmv, fmvSource: 'active-median' }) };

} catch (err) {
    console.error('ebay-search error:', err);
    return { statusCode: 500, headers: headers, body: JSON.stringify({ error: 'Search failed', detail: err.message }) };
}

};
