const { _ } = require('@genx/july');
const { ValidationError } = require('../utils/Errors');

function normalizePhone(phone, defaultArea) {
    if (phone) {
        phone = phone.trim();
        
        if (phone.length > 0) {
            let s = phone[0];
            if (s === '+') {
                //nothing
            } else if (s === '0') {
                if (phone[1] === '0') {
                    phone = '+' + phone.substr(2);
                } else {
                    if (defaultArea == null) {
                        throw new ValidationError('The mobile phone number must be supplied with a country code.', {
                            data: phone
                        });
                    }
                    phone = defaultArea + phone.substr(1);
                }
            } else {
                if (defaultArea == null) {
                    throw new ValidationError('The mobile phone number must be supplied with a country code.', {
                        data: phone
                    });
                }
                phone = defaultArea + phone;
            }

            let leftB = phone.indexOf('(');
            let rightB = phone.indexOf(')');

            if (leftB > 0 && rightB > leftB) {
                phone = phone.substr(0, leftB) + _.trimStart(phone.substring(leftB+1, rightB), '0') + phone.substr(rightB+1);
            }

            phone = phone.replace(/\ |\-/g, '');
        }
    }

    return phone;
}

module.exports = normalizePhone;