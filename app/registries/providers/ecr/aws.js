const crypto = require('crypto');
const rp = require('../../../request');

const SERVICE = 'ecr';
const TARGET = 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

/**
 * Build a SigV4-signed GetAuthorizationToken request (the only ECR API call
 * needed, which does not justify pulling in the whole AWS SDK).
 */
function signGetAuthorizationToken({ accessKeyId, secretAccessKey, region }, date) {
    const host = `api.ecr.${region}.amazonaws.com`;
    const amzDate = date.toISOString().replace(/[-:]|\.\d{3}/g, '');
    const shortDate = amzDate.slice(0, 8);
    const body = '{}';

    // Canonical headers must be lowercase and sorted by name.
    const headers = {
        'content-type': 'application/x-amz-json-1.1',
        host,
        'x-amz-date': amzDate,
        'x-amz-target': TARGET,
    };
    const signedHeaders = Object.keys(headers).join(';');
    const canonicalHeaders = Object.entries(headers).map(([name, value]) => `${name}:${value}\n`).join('');
    const canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, sha256(body)].join('\n');

    const scope = `${shortDate}/${region}/${SERVICE}/aws4_request`;
    const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');

    const signingKey = [shortDate, region, SERVICE, 'aws4_request']
        .reduce((key, part) => hmac(key, part), `AWS4${secretAccessKey}`);
    const signature = crypto.createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return {
        uri: `https://${host}/`,
        body,
        headers: {
            'Content-Type': headers['content-type'],
            'X-Amz-Date': amzDate,
            'X-Amz-Target': TARGET,
            Authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
        },
    };
}

async function getAuthorizationToken(credentials, date = new Date()) {
    const { uri, headers, body } = signGetAuthorizationToken(credentials, date);
    const response = await rp({
        method: 'POST',
        uri,
        headers,
        body,
        json: true,
    });
    return response.authorizationData[0].authorizationToken;
}

module.exports = {
    signGetAuthorizationToken,
    getAuthorizationToken,
};
