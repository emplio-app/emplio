# Namecheap coverage

Sources, swept 16 Nov 2026: Namecheap's API reference (namecheap.com/support/api/methods, behind a Cloudflare
check, so read through the copy in namecheap/go-namecheap-sdk `docs/namecheap-api-v2.md`) and that official SDK's
command files and captured XML responses, which add `whoisguard.allot`, `unallot` and `discard`.
Composio has no Namecheap toolkit; n8n has no Namecheap node.

64 actions: all 62 API commands, plus `add_dns_records` and `delete_dns_records` on top (setHosts replaces every
record, so these read the records, change the list and write it back, keeping the email setting).

## Deliberately left out

| What | Why |
| --- | --- |
| Sandbox (api.sandbox.namecheap.com) | A separate test account; business owners connect their real account |
| Webhooks | Namecheap has none; everything is polled (below) |

## Auth

| Method | Status |
| --- | --- |
| API user + API key, pasted as `USERNAME:APIKEY` (or `APIUSER:APIKEY:USERNAME` to act on another username) | done; `check` reads `users.getBalances` |
| IP allow-list | Every call sends `ClientIp` = `NAMECHEAP_CLIENT_IP` (the server's public IPv4). The key help says to add that IP; an IP refusal tells the owner again |
| API access eligibility | Namecheap turns API access on only with $50 balance, $50 spent in 2 years, or 20+ domains; said in the key help |
| OAuth | Namecheap has none |

## Adjustments by hand

- XML answers parsed into JSON (`client.ts`, no new dependency); `Status="ERROR"` (sent as HTTP 200) and `IsSuccess="false"` are failures; HTTP 405 is the rate limit.
- Key errors (1011102 and kin) mark the connection for reconnecting; IP errors don't.
- Commands that take `SLD`/`TLD` take `DomainName` and split it (example.co.uk → example + co.uk).
- Numbered fields (HostName1…, MailBox1…) are taken as lists; contacts as objects (Tech/Admin/Billing default to the owner); list fields as arrays.
- `add_funds_request` fills `Username` and `PaymentType=Creditcard`; `create_user` sends `AcceptTerms=1`.

## Triggers (polled, `polls/namecheap.ts`)

| Trigger | How |
| --- | --- |
| domain_expiring_soon | domains.getList, expiry within `days` (30); once per domain per expiry date |
| new_domain | domains.getList newest first |
| domain_changed | domains.getList; auto-renew, lock, privacy, expired or expiry date differs |
| dns_records_changed | dns.getHosts of one domain; hash of the records |
| transfer_status_changed | transfer.getList; transfer id + status |
| ssl_expiring_soon | ssl.getList Active, expiry within `days` |
| low_balance | users.getBalances below `below`, or below funds needed for auto-renew; at most daily |

## Actions (`*` asks first)

- Domains (11): list_domains, get_domain_info, get_domain_contacts, set_domain_contacts*, check_domain_availability, register_domain*, list_tlds, renew_domain*, reactivate_domain*, get_registrar_lock, set_registrar_lock*
- Transfers (4): create_transfer*, get_transfer_status, update_transfer_status*, list_transfers
- DNS (9): get_dns_servers, set_default_dns*, set_custom_nameservers*, get_dns_hosts, set_dns_hosts*, add_dns_records*, delete_dns_records*, get_email_forwarding, set_email_forwarding*
- Own nameservers (4): create_nameserver*, get_nameserver_info, update_nameserver*, delete_nameserver*
- SSL (13): list_ssl_certificates, get_ssl_certificate, buy_ssl_certificate*, parse_csr, get_ssl_approver_emails, activate_ssl_certificate*, resend_ssl_approver_email*, edit_ssl_dcv_method*, renew_ssl_certificate*, reissue_ssl_certificate*, resend_ssl_fulfillment_email*, buy_more_ssl_domains*, revoke_ssl_certificate*
- Account (9): get_balances, get_pricing, update_account*, change_password*, add_funds_request*, get_add_funds_status, create_user*, login_user, reset_password*
- Addresses (6): list_addresses, get_address, create_address*, update_address*, delete_address*, set_default_address*
- Domain privacy (8): list_domain_privacy, enable_domain_privacy*, disable_domain_privacy*, change_domain_privacy_email*, renew_domain_privacy*, allot_domain_privacy*, unallot_domain_privacy*, discard_domain_privacy*

Not tried live: no Namecheap account was used; everything is checked against the SDK's captured responses with `fetch` faked.
