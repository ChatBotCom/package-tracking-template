'use strict';

const axios = require('axios');
const express = require('express');
const { Router } = require('express');
const router = new Router();
const app = express();
const functions = require('firebase-functions');
const firebase = require('firebase-admin');

// go to config.json file and put your authorization data
const { ups, token } = require('./config.json');

/**
 * @param {String} InquiryNumber
 *
 * @returns {Object}
 */
const isSandboxInquiryNumber = InquiryNumber => {
    /*
        🚗 UPS Available statuses 🚗

        I = In Transit
        D = Delivered
        X = Exception
        P = Pickup
        M = Manifest Pickup
        E = Error
    */
    const number = [
        {
            trackingNumber: '1ZCB345E020527168I',
            statusType: 'I',
            statusDescription: 'Your package is moving within the UPS network and is going to be delivered on the scheduled delivery date.'
        },
        {
            trackingNumber: '1ZCB345E020527168D',
            statusType: 'D',
            statusDescription: 'The shipment was successfully delivered.'
        },
        {
            trackingNumber: '1ZCB345E020527168X',
            statusType: 'X',
            statusDescription: 'Custom hold, undeliverable, shipper has shipped or shipped an exception.'
        },
        {
            trackingNumber: '1ZCB345E020527168P',
            statusType: 'P',
            statusDescription: 'Picked Up.'
        },
        {
            trackingNumber: '1ZCB345E020527168M',
            statusType: 'M',
            statusDescription: 'UPS has received the electronic transmission of the shipment details and billing information for this shipment from the sender.'
        },
        {
            trackingNumber: '1ZCB345E020527168E',
            statusType: 'E',
            statusDescription: 'Something went wrong. Please try again later.'
        }
    ].filter(n => n.trackingNumber === InquiryNumber);

    return number.length ? number[0] : false;
};

/**
 * @param {String} InquiryNumber
 *
 * @returns {Object}
 */
const checkUPSTrackingStatus = async InquiryNumber => {
    const { url, username, password, accessKey } = ups;
    const json = {
        UPSSecurity: {
            UsernameToken: {
                Username: username,
                Password: password
            },
            ServiceAccessToken: {
                AccessLicenseNumber: accessKey
            }
        },
        TrackRequest: {
            InquiryNumber
        }
    };

    const { data } = await axios.post(url, json);

    try {
        const { Package } = data.TrackResponse.Shipment;
        const trackingNumber = Package.TrackingNumber;
        const activity = Array.isArray(Package.Activity) ? Package.Activity[0] : Package.Activity;

        return {
            trackingNumber,
            statusType: activity.Status.Type,
            statusDescription: activity.Status.Description
        };
    } catch (e) {
        const { Code, Description } = data.Fault.detail.Errors.ErrorDetail.PrimaryErrorCode;

        // check the number of returned error code; api should return
        // only errors related to the status of the package based on
        // the 'Tracking Web Service Developer Guide' created by UPS
        let err;

        if (Number(Code) >= 150000 && Number(Code) <= 155006) {
            err = Description;
        } else {
            err = 'Something went wrong. Please try again later.';
        }

        return { err };
    }
};

/**
 * @param {String} InquiryNumber
 *
 * @returns {Boolean}
 */
const checkInquiryNumber = InquiryNumber => {
    if (!InquiryNumber || !InquiryNumber.length) {
        return false;
    }

    // check if the provided tracking number is correct
    if (!InquiryNumber.match(/\b(1Z ?[0-9A-Z]{3} ?[0-9A-Z]{3} ?[0-9A-Z]{2} ?[0-9A-Z]{4} ?[0-9A-Z]{3} ?[0-9A-Z]|[\dT]\d\d\d ?\d\d\d\d ?\d\d\d)\b/)) {
        return false;
    }

    return true;
};

router
    .route('/')
    .get((req, res) => {
        if (req.query.token !== token) {
            return res.sendStatus(401);
        }

        return res.end(req.query.challenge);
    });

router
    .route('/')
    .post((req, res, next) => {
        if (req.query.token !== token) {
            return res.sendStatus(401);
        }

        const action = req.body.result.interaction.action;

        if (['track-order'].includes(action)) {
            req.url = `/${action}`;
            return next();
        }

        res.json();
    });

router
    .route('/track-order')
    .post(async (req, res) => {
        const { trackingNumber } = req.body.result.sessionParameters;

        let parameters = {
            trackingNumber
        };

        if (!checkInquiryNumber(trackingNumber)) {
            parameters.statusType = 'E';
            parameters.statusDescription = 'Invalid tracking number.';

            return res.json({ parameters });
        }

        const isSandbox = isSandboxInquiryNumber(trackingNumber);

        if (isSandbox) {
            return res.json({ parameters: isSandbox });
        }

        const data = await checkUPSTrackingStatus(trackingNumber);

        parameters.statusType = data.err ? 'E' : data.statusType;
        parameters.statusDescription = data.err ? data.err : data.statusDescription;

        return res.json({ parameters });
    });

app.use(router);

exports.packageTrackingBot = functions.https.onRequest((req, res) => {
    if (!req.path) {
        req.url = `/${req.url}`;
    }

    return app(req, res);
});
