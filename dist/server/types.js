"use strict";
// ─── Enums ───────────────────────────────────────────────────────────────────
Object.defineProperty(exports, "__esModule", { value: true });
exports.Phase = exports.Role = void 0;
var Role;
(function (Role) {
    Role["Civilian"] = "civilian";
    Role["Mafia"] = "mafia";
    Role["Detective"] = "detective";
    Role["Doctor"] = "doctor";
    Role["Prostitute"] = "prostitute";
})(Role || (exports.Role = Role = {}));
var Phase;
(function (Phase) {
    Phase["Lobby"] = "lobby";
    Phase["Speaking"] = "speaking";
    Phase["Discussion"] = "discussion";
    Phase["Voting"] = "voting";
    Phase["NightResult"] = "nightresult";
    Phase["Night"] = "night";
    Phase["GameOver"] = "gameover";
})(Phase || (exports.Phase = Phase = {}));
