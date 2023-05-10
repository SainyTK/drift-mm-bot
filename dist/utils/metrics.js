"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.metricAttrFromUserAccount = void 0;
function metricAttrFromUserAccount(userAccountKey, ua) {
    return {
        subaccount_id: ua.subAccountId,
        public_key: userAccountKey.toBase58(),
        authority: ua.authority.toBase58(),
        delegate: ua.delegate.toBase58(),
    };
}
exports.metricAttrFromUserAccount = metricAttrFromUserAccount;
