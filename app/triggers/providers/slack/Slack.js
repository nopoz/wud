const rp = require('../../../request');
const Trigger = require('../Trigger');

/*
 * Slack Trigger implementation
 */
class Slack extends Trigger {
    /*
     * Get the Trigger configuration schema.
     * @returns {*}
     */
    getConfigurationSchema() {
        return this.joi.object().keys({
            token: this.joi.string().required(),
            channel: this.joi.string().required(),
        });
    }

    /**
     * Sanitize sensitive data
     * @returns {*}
     */
    maskConfiguration() {
        return {
            ...this.configuration,
            channel: this.configuration.channel,
            token: Slack.mask(this.configuration.token),
        };
    }

    /*
     * Post a message with new image version details.
     *
     * @param image the image
     * @returns {Promise<void>}
     */
    async trigger(container) {
        return this.postMessage(this.renderSimpleBody(container));
    }

    async triggerBatch(containers) {
        return this.postMessage(this.renderBatchBody(containers));
    }

    /**
     * Post a message to a Slack channel.
     * @param text the text to post
     * @returns {Promise<*>}
     */
    async postMessage(text) {
        const response = await rp({
            method: 'POST',
            uri: 'https://slack.com/api/chat.postMessage',
            auth: { bearer: this.configuration.token },
            body: {
                channel: this.configuration.channel,
                text,
            },
            json: true,
        });
        // Slack reports API errors in a 200 body rather than a status code.
        if (!response.ok) {
            throw new Error(`Slack API error: ${response.error}`);
        }
        return response;
    }
}

module.exports = Slack;
