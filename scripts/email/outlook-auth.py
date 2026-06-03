#!/usr/bin/env python3
"""
Outlook OAuth2 Device Code Flow
Authenticates a user and stores tokens in macOS Keychain under the
himalaya-cli service, matching the schema expected by outlook-imap.py.

Usage:
    outlook-auth.py                      # signs in as daveh (default account)
    outlook-auth.py --account <name>     # signs in as named account, e.g. chrissyhurley
"""

import subprocess
import json
import time
import urllib.request
import urllib.parse
import sys
import base64


DEFAULT_ACCOUNT = "daveh"

# Must match outlook-imap.py constants exactly
AUTHORITY = "https://login.microsoftonline.com/consumers"
SCOPES = (
    "offline_access "
    "https://outlook.office.com/IMAP.AccessAsUser.All "
    "https://outlook.office.com/SMTP.Send"
)


def get_keychain(service, account=None):
    """Get value from macOS Keychain."""
    try:
        cmd = ["security", "find-generic-password", "-s", service]
        if account:
            cmd.extend(["-a", account])
        cmd.append("-w")
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        return result.stdout.strip()
    except subprocess.CalledProcessError:
        return None


def set_keychain(service, account, value):
    """Set value in macOS Keychain (update if exists)."""
    subprocess.run(
        ["security", "add-generic-password", "-s", service, "-a", account, "-w", value, "-U"],
        check=True
    )


def extract_email_from_token(access_token):
    """Try to extract user email from the access token JWT payload."""
    try:
        payload = access_token.split(".")[1]
        # Add padding if needed
        payload += "=" * (4 - len(payload) % 4)
        decoded = json.loads(base64.urlsafe_b64decode(payload))
        return (
            decoded.get("preferred_username")
            or decoded.get("upn")
            or decoded.get("unique_name")
            or decoded.get("email")
        )
    except Exception:
        return None


def device_code_flow(account_name):
    """Run the OAuth2 device code flow for the given account name."""
    client_id = get_keychain("credential-outlook-client-id")

    if not client_id:
        print("ERROR: Missing client_id in Keychain (service: credential-outlook-client-id)")
        sys.exit(1)

    # Step 1: Request device code
    device_url = f"{AUTHORITY}/oauth2/v2.0/devicecode"
    data = urllib.parse.urlencode({
        "client_id": client_id,
        "scope": SCOPES
    }).encode()

    req = urllib.request.Request(device_url, data=data, method="POST")
    with urllib.request.urlopen(req) as resp:
        device_response = json.loads(resp.read().decode())

    # Show user instructions
    print("\n" + "=" * 60)
    print("OUTLOOK AUTHORIZATION REQUIRED")
    print("=" * 60)
    print(f"\n1. Open: {device_response['verification_uri']}")
    print(f"2. Enter code: {device_response['user_code']}")
    print(f"\nCode expires in {device_response['expires_in'] // 60} minutes")
    print("=" * 60 + "\n")
    print(f"Waiting for authorization (account: {account_name})...")

    # Step 2: Poll for token
    token_url = f"{AUTHORITY}/oauth2/v2.0/token"
    interval = device_response.get("interval", 5)

    while True:
        time.sleep(interval)

        token_data = urllib.parse.urlencode({
            "grant_type": "urn:ietf:params:oauth:grant-type:device_code",
            "client_id": client_id,
            "device_code": device_response["device_code"]
        }).encode()

        token_req = urllib.request.Request(token_url, data=token_data, method="POST")

        try:
            with urllib.request.urlopen(token_req) as resp:
                token_response = json.loads(resp.read().decode())

                access_token = token_response.get("access_token")
                refresh_token = token_response.get("refresh_token")

                if not refresh_token:
                    print("ERROR: No refresh token in response")
                    return False

                # Store all three tokens under himalaya-cli, matching outlook-imap.py reader schema:
                #   service="himalaya-cli", account="credential-outlook-{account_name}-{token_type}"
                set_keychain("himalaya-cli", f"credential-outlook-{account_name}-refresh-token", refresh_token)
                if access_token:
                    set_keychain("himalaya-cli", f"credential-outlook-{account_name}-access-token", access_token)

                # Extract and store user email from access token
                user_email = extract_email_from_token(access_token) if access_token else None
                if user_email:
                    set_keychain("himalaya-cli", f"credential-outlook-{account_name}-user", user_email)

                print(f"\n✓ Authorization successful!")
                if user_email:
                    print(f"  User: {user_email}")
                print(f"✓ Tokens stored in Keychain (service: himalaya-cli)")
                print(f"  Keys written:")
                print(f"    credential-outlook-{account_name}-refresh-token")
                if access_token:
                    print(f"    credential-outlook-{account_name}-access-token")
                if user_email:
                    print(f"    credential-outlook-{account_name}-user")
                else:
                    print(f"  Note: could not extract email from token.")
                    print(f"  Store it manually:")
                    print(f"    security add-generic-password -s himalaya-cli "
                          f"-a credential-outlook-{account_name}-user -w <email> -U")
                return True

        except urllib.error.HTTPError as e:
            error_body = json.loads(e.read().decode())
            error_code = error_body.get("error")

            if error_code == "authorization_pending":
                print(".", end="", flush=True)
                continue
            elif error_code == "slow_down":
                interval += 5
                continue
            elif error_code == "expired_token":
                print("\nERROR: Device code expired. Please try again.")
                return False
            else:
                print(f"\nERROR: {error_body.get('error_description', error_code)}")
                return False


if __name__ == "__main__":
    # Parse --account argument
    account_name = DEFAULT_ACCOUNT
    args = sys.argv[1:]
    i = 0
    while i < len(args):
        if args[i] == "--account" and i + 1 < len(args):
            account_name = args[i + 1]
            i += 2
        else:
            i += 1

    device_code_flow(account_name)
