const rp = require('../../../request');
const { signGetAuthorizationToken, getAuthorizationToken } = require('./aws');

jest.mock('../../../request');

const credentials = {
    accessKeyId: 'AKIDEXAMPLE',
    secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
    region: 'us-east-1',
};
const date = new Date('2026-09-11T12:34:56.789Z');

test('signGetAuthorizationToken should produce a SigV4 signed request', () => {
    expect(signGetAuthorizationToken(credentials, date)).toStrictEqual({
        uri: 'https://api.ecr.us-east-1.amazonaws.com/',
        body: '{}',
        headers: {
            'Content-Type': 'application/x-amz-json-1.1',
            'X-Amz-Date': '20260911T123456Z',
            'X-Amz-Target': 'AmazonEC2ContainerRegistry_V20150921.GetAuthorizationToken',
            Authorization: 'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20260911/us-east-1/ecr/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-target, Signature=8564714ecba179a4c4a7f9c0d5ff8661384e3c8158b3ba9bfbda5cc98600bc3f',
        },
    });
});

test('getAuthorizationToken should post the signed request and return the token', async () => {
    rp.mockResolvedValue({ authorizationData: [{ authorizationToken: 'xxxxx' }] });
    await expect(getAuthorizationToken(credentials, date)).resolves.toEqual('xxxxx');
    expect(rp).toHaveBeenCalledWith({
        method: 'POST',
        uri: 'https://api.ecr.us-east-1.amazonaws.com/',
        body: '{}',
        json: true,
        headers: expect.objectContaining({
            'X-Amz-Date': '20260911T123456Z',
            Authorization: expect.stringMatching(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20260911\/us-east-1\/ecr\/aws4_request, /),
        }),
    });
});
