import { FunctionEvent, fromEvent } from "graphcool-lib";
import { GraphQLClient } from "graphql-request";
import fetch from "cross-fetch";
import { google } from "googleapis";
import { androidpublisher_v2 } from "googleapis";
import * as path from "path";

interface Subscription {
  id: string;
  receipt: string;
}

const APPLE_VERIFY_RECEIPT_SUBDOMAIN =
  process.env["APPLE_VERIFY_RECEIPT_SUBDOMAIN"];
const APPLE_SHARED_SECRET = process.env["APPLE_SHARED_SECRET"];
const ANDROID_PACKAGE_NAME = process.env["ANDROID_PACKAGE_NAME"];

export default async (event: FunctionEvent<{}>) => {
  console.log(event);

  try {
    // no logged in user
    if (!event.context.auth || !event.context.auth.nodeId) {
      return { error: "Login required!" };
    }

    const userId = event.context.auth.nodeId;
    const graphcool = fromEvent(event);
    const api = graphcool.api("simple/v1");
    const today = new Date();

    let lastSubscription: any = await getLastSubscription(api, userId);
    if (lastSubscription[0]) {
      const lastExpiryDate = new Date(lastSubscription[0].expiryDate);

      if (lastExpiryDate > today) {
        return {
          data: { result: true, expiryDate: lastExpiryDate.toISOString() }
        };
      }
    }
    const lastReceipt: any = await getLastReceipt(api, userId);
    if (lastReceipt.length > 0) {
      const body = {
        "receipt-data": lastReceipt[0].receipt,
        password: APPLE_SHARED_SECRET,
        "exclude-old-transactions": "true"
      };
      const appleResponse: any = await fetch(
        `https://${APPLE_VERIFY_RECEIPT_SUBDOMAIN}.itunes.apple.com/verifyReceipt`,
        {
          method: "post",
          body: JSON.stringify(body)
        }
      ).then(r => r.json());
      if (
        appleResponse &&
        appleResponse.status == 0 &&
        appleResponse.latest_receipt_info[0]
      ) {
        const expiryDateMs =
          appleResponse.latest_receipt_info[0].expires_date_ms;
        const expiryDate = new Date(parseInt(expiryDateMs));

        const purchaseDateMs =
          appleResponse.latest_receipt_info[0].purchase_date_ms;
        const purchaseDate = new Date(parseInt(purchaseDateMs));
        if (expiryDate > today) {
          const newUser = await createSubscription(
            api,
            userId,
            expiryDate.toISOString(),
            purchaseDate.toISOString(),
            today.toISOString(),
            appleResponse.latest_receipt
          );
          if (newUser) {
            return {
              data: { result: true, expiryDate: expiryDate.toISOString() }
            };
          }
        }
      }
    }

    const lastPurchaseToken: any = await getLastPurchaseToken(api, userId);
    if (lastPurchaseToken.length > 0) {
      const googleData: androidpublisher_v2.Schema$SubscriptionPurchase | null = await verifyGoogle(
        lastPurchaseToken[0].subscriptionId,
        lastPurchaseToken[0].purchaseToken
      );
      if (googleData) {
        const startMillis = parseInt(googleData.startTimeMillis || "0");
        const expiryMillis = parseInt(googleData.expiryTimeMillis || "0");
        const startDate = new Date(startMillis);
        const expiryDate = new Date(expiryMillis);
        if (expiryDate > today) {
          const owner = await createSubscription(
            api,
            userId,
            expiryDate.toISOString(),
            today.toISOString(),
            startDate.toISOString(),
            undefined,
            lastPurchaseToken[0].purchaseToken,
            lastPurchaseToken[0].subscriptionId
          );
          if (owner) {
            return {
              data: { result: true, expiryDate: expiryDate.toISOString() }
            };
          }
        }
      }
    }

    return { data: { result: false, expiryDate: today.toISOString() } };
  } catch (e) {
    console.log(e);
    return { error: "An unexpected error occured during authentication." };
  }
};

const verifyGoogle = async (
  subscriptionId: string,
  token: string
): Promise<androidpublisher_v2.Schema$SubscriptionPurchase | null> => {
  // Create a new JWT client using the key file downloaded from the Google Developer Console
  const client = await google.auth.getClient({
    keyFile: path.join(__dirname, "keyfile.json"),
    scopes: "https://www.googleapis.com/auth/androidpublisher"
  });
  // api parameters to send
  const params = {
    packageName: ANDROID_PACKAGE_NAME,
    subscriptionId,
    token
  };
  // Obtain a new client, making sure you pass along the auth client
  const publisher = google.androidpublisher({
    version: "v2",
    auth: client
  });

  // Make an authorized request to get subscription info.
  return publisher.purchases.subscriptions
    .get(params)
    .then(r => r.data)
    .catch(() => {
      return null;
    });
};

async function getLastPurchaseToken(
  api: GraphQLClient,
  id: string
): Promise<{ allSubscriptions }> {
  const query = `
    query getLastPurchaseToken($id: ID!) {
      allSubscriptions(filter: {user: {id: $id}, purchaseToken_not: null}, orderBy: expiryDate_DESC, first: 1) {
        purchaseToken
        subscriptionId
      }
    }
  `;

  const variables = {
    id
  };

  return api
    .request<{ allSubscriptions }>(query, variables)
    .then(r => r.allSubscriptions);
}

async function getLastReceipt(
  api: GraphQLClient,
  id: string
): Promise<{ allSubscriptions }> {
  const query = `
    query getLastReceipt($id: ID!) {
      allSubscriptions(
        filter: {
          user: {
            id: $id
          },
          receipt_not: null
        }, 
        orderBy: expiryDate_DESC, 
        first: 1
      ) {
        receipt
      }
    }
  
  `;

  const variables = {
    id
  };

  return api
    .request<{ allSubscriptions }>(query, variables)
    .then(r => r.allSubscriptions);
}

async function getLastSubscription(
  api: GraphQLClient,
  id: string
): Promise<{ allSubscriptions }> {
  const query = `
    query getLastSubscription($id: ID) {
      allSubscriptions(filter: {user: {id: $id}}, orderBy: expiryDate_DESC, first: 1) {
        expiryDate
      }
    }
  `;

  const variables = {
    id
  };

  return api
    .request<{ allSubscriptions }>(query, variables)
    .then(r => r.allSubscriptions);
}

async function createSubscription(
  api: GraphQLClient,
  userId: string,
  expiryDate: string,
  purchaseDate: string,
  startDate: string,
  receipt?: string,
  purchaseToken?: string,
  subscriptionId?: string
): Promise<string> {
  const mutation = `
    mutation createSubscription(
      $expiryDate: DateTime, 
      $purchaseDate: DateTime, 
      $startDate: DateTime,
      $receipt: String,
      $userId: ID,
      $purchaseToken: String,
      $subscriptionId: String) {
      createSubscription(
        expiryDate: $expiryDate, 
        purchaseDate: $purchaseDate, 
        startDate: $startDate,
        receipt: $receipt, 
        userId: $userId,
        purchaseToken: $purchaseToken,
        subscriptionId: $subscriptionId) 
      {
        id
      }
    }
  `;

  const variables = {
    expiryDate,
    purchaseDate,
    startDate,
    receipt,
    userId,
    purchaseToken,
    subscriptionId
  };

  return api
    .request<{ createSubscription: Subscription }>(mutation, variables)
    .then(r => r.createSubscription.id);
}
