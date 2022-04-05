# ghost-store

## Sell downloads and masterclasses on Ghost.

[Ghost](https://ghost.org/) is an amazing open source publication platform used by content creators to monetize their content.

Selling downloads and masterclasses is not currently possible on Ghost so I created ghost-store to scratch my own itch.

Implementing ghost-store it not straightforward… this repo was made public so other technologists don’t have to go down the rabbit hole like I did.

**Want to experience ghost-store?** [Join](https://sunknudsen.com/join/) and check out [https://sunknudsen.com/qr-bridge/](https://sunknudsen.com/qr-bridge/).

## Implementation overview

### Step 1: create and configure [Stripe](https://stripe.com/) account

Go to [https://dashboard.stripe.com/settings/user](https://dashboard.stripe.com/settings/user) and configure user.

Go to [https://dashboard.stripe.com/settings/emails](https://dashboard.stripe.com/settings/emails) and configure emails.

Go to [https://dashboard.stripe.com/settings/branding](https://dashboard.stripe.com/settings/branding) and configure branding.

### Step 2: create restricted Stripe API key

Go to [https://dashboard.stripe.com/developers](https://dashboard.stripe.com/developers) and create restricted API key with following permissions.

Customers 👉 Read

Checkout Sessions 👉 Read

Promotion Codes 👉 Write

### Step 3: create Stripe webhook

Go to [https://dashboard.stripe.com/webhooks](https://dashboard.stripe.com/webhooks) and create webhook with following events that points to ghost-store service.

Events to send 👉 `checkout.session.completed`

### Step 4: add Stripe products and create payment links

Go to [https://dashboard.stripe.com/products](https://dashboard.stripe.com/products), add products and create payment links

### Step 5: create database, user and grant privileges using `mysql --user root --password`

> Heads-up: replace `ghost_store_prod`, `ghost-store-123` and `d4q6g3w2kulttgtvsw43u5z8f69k` to match environment variables in `.env`.

```shell
CREATE DATABASE ghost_store_prod;
CREATE USER 'ghost-store-123'@'localhost' IDENTIFIED BY 'd4q6g3w2kulttgtvsw43u5z8f69k';
GRANT ALL PRIVILEGES ON ghost_store_prod.* TO 'ghost-store-123'@'localhost';
FLUSH PRIVILEGES;
```

### Step 6: add ghost-store custom integration on `/ghost/#/settings/integrations`

### Step 7: append following code after `{{ghost_head}}` in `default.hbs` (see [example](https://github.com/sunknudsen/custom-ghost-edition-theme/blob/a4e1f033b013d7c0e04e14e8c873f38a2390b41e/default.hbs#L12-L15))

```handlebars
{{#if @member}}

  <script>var member_email="{{@member.email}}";</script>
{{/if}}
```

### Step 8: create confirmation page (configured using `GHOST_CONFIRMATION_PAGE` environment variable, see [example](https://sunknudsen.com/almost-there/))

### Step 9: configure and run ghost-store

Clone [ghost-store](https://github.com/sunknudsen/ghost-store), create `.env`, `store.json` and `template.hbs`, run `node index.js` and point subdomain to service (complexity of step has been abstracted).

## Usage overview

### Offer discounts to members using promo code buttons

#### Step 1: create coupon on Stripe

> Heads-up: coupons can be product-specific.

> Heads-up: do not use coupon dashboard to create codes as they are create programmatically.

Go to https://dashboard.stripe.com/coupons and create coupon.

#### Step 2: add product to `store.json`

```console
$ cat store.json
{
  "bitcoin-self-custody-masterclass": {
    "id": "prod_L2EwNuviYnZhDc",
    "name": "Bitcoin self-custody masterclass",
    "paymentLink": "https://buy.stripe.com/test_fZe29c7Z17Nlb2obIK",
    "cdn": {
      "expiry": {
        "amount": 90,
        "unit": "days"
      },
      "redirect": "http://localhost:2368/bitcoin-self-custody-masterclass/"
    },
    "members": {
      "discount": 0.15,
      "coupon": "aVsxvMvx"
    }
  }
}
```

#### Step 3: add following custom HTML to page or post after public preview

> Heads-up: replace `http://localhost:8443` to match environment variable in `.env`.

> Heads-up: replace `bitcoin-self-custody-masterclass` to match product in `store.json`.

> Heads-up: adjust class attributes to match template.

```html
<form
  action="http://localhost:8443/promo-code"
  method="post"
  onsubmit="this.email.value = member_email"
  target="_blank"
>
  <input name="path" type="hidden" value="bitcoin-self-custody-masterclass" />
  <input name="email" type="hidden" />
  <div class="kg-card kg-button-card kg-align-left">
    <button class="kg-btn kg-btn-accent">🐰 Get promo code</button>
  </div>
</form>
```

#### Step 4: create `GHOST_STORE_CONFIRMATION_PAGE` page

### Offer complimentary product to members using product buttons

#### Step 1: add product to `store.json`

```console
$ cat store.json
{
  "qr-bridge": {
    "id": "prod_L2EsSVD8OwVBPm",
    "name": "QR Bridge",
    "paymentLink": "https://buy.stripe.com/test_aEU014cfh0kT6M8001",
    "downloads": {
      "qr-bridge.AppImage": "qr-bridge-1.1.0.AppImage",
      "qr-bridge.AppImage.asc": "qr-bridge-1.1.0.AppImage.asc"
    },
    "members": {
      "discount": 1
    }
  }
}
```

#### Step 2: add following custom HTML to page or post after public preview

> Heads-up: replace `http://localhost:8443` to match environment variable in `.env`.

> Heads-up: replace `qr-bridge` to match product in `store.json`.

> Heads-up: adjust class attributes to match template.

```html
<form
  action="http://localhost:8443/store"
  method="post"
  onsubmit="this.email.value = member_email"
  target="_blank"
>
  <input name="path" type="hidden" value="qr-bridge" />
  <input name="email" type="hidden" />
  <div class="kg-card kg-button-card kg-align-left">
    <button class="kg-btn kg-btn-accent">🐰 Download</button>
  </div>
</form>
```

#### Step 3: create `GHOST_STORE_CONFIRMATION_PAGE` page

### Offer complimentary product to anyone using API

#### Step 1: install [HTTPie](https://httpie.io/)

#### Step 2: send `POST` request to `/admin`

> Heads-up: replace `http://localhost:8443` and `b1vtyyzkhrcqosg0iioi4b6w7zo0` to match environment variables in `.env`.

> Heads-up: replace `qr-bridge` to match product in `store.json`.

```console
$ http POST http://localhost:8443/admin \
"Authorization: Bearer b1vtyyzkhrcqosg0iioi4b6w7zo0" \
name="John Doe" \
email="john@privacyconscio.us" \
path="qr-bridge"
{
    "sent": true
}
```

### Create poll

#### Step 1: add poll to `polls.json`

```console
$ cat polls.json
{
  "bitcoin-masterclass": {
    "type": "email",
    "unique": true
  }
}
```

#### Step 2: add following custom HTML to page or post

> Heads-up: replace `http://localhost:8443` to match environment variable in `.env`.

> Heads-up: replace `bitcoin-masterclass` to match poll in `polls.json`.

> Heads-up: adjust class attributes to match template.

```html
<form
  action="http://localhost:8443/polls"
  method="post"
  onsubmit="t=this; setTimeout(() => { t.reset() }, 0)"
  target="_blank"
>
  <input name="name" type="hidden" value="bitcoin-masterclass" />
  <input name="response" type="email" placeholder="Enter your email" required />
  <div class="kg-card kg-button-card kg-align-left">
    <button class="kg-btn kg-btn-accent">🐰 Submit</button>
  </div>
</form>
```

#### Step 3: create `GHOST_POLLS_CONFIRMATION_PAGE` page

### Fetch poll data

#### Step 1: install [HTTPie](https://httpie.io/)

#### Step 2: send `GET` request to `/polls/:name`

> Heads-up: replace `http://localhost:8443` and `b1vtyyzkhrcqosg0iioi4b6w7zo0` to match environment variables in `.env`.

> Heads-up: replace `bitcoin-masterclass` to match poll in `polls.json`.

```console
$ http GET http://localhost:8443/polls/bitcoin-masterclass \
"Authorization: Bearer b1vtyyzkhrcqosg0iioi4b6w7zo0"
{
    "data": [
        "john@privacyconscio.us"
    ],
    "name": "bitcoin-masterclass",
    "responses": 1
}
```

### Send message to poll participants (requires `"type": "email"`)

#### Step 1: install [HTTPie](https://httpie.io/)

#### Step 2: send `POST` request to `/polls/:name/sendmail`

> Heads-up: replace `http://localhost:8443` and `b1vtyyzkhrcqosg0iioi4b6w7zo0` to match environment variables in `.env`.

> Heads-up: replace `bitcoin-masterclass` to match poll in `polls.json`.

> Heads-up: use `preview=true` to send preview email to `FROM_EMAIL`.

```console
$ http POST http://localhost:8443/polls/bitcoin-masterclass/sendmail \
'Authorization: Bearer b1vtyyzkhrcqosg0iioi4b6w7zo0' \
subject='Hey!' \
body="$(cat << "EOF"
Message goes here…
EOF
)" \
preview=true
{
    "preview": true,
    "recipients": [
        "sun@privacyconscio.us"
    ],
    "sent": true
}
```
