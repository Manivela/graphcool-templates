import { fromEvent, FunctionEvent } from "graphcool-lib";
import { GraphQLClient } from "graphql-request";
import fetch from "cross-fetch";
import { google, androidpublisher_v2 } from "googleapis";
import * as path from "path";

interface User {
  id: string;
}

interface Subscription {
  id: string;
  expiryDate: string;
  purchaseDate: string;
  receipt: string;
  userId: string;
}

interface EventData {
  receipt: string;
  purchaseToken: string;
  subscriptionId: string;
}

const APPLE_VERIFY_RECEIPT_SUBDOMAIN =
  process.env["APPLE_VERIFY_RECEIPT_SUBDOMAIN"];
const APPLE_SHARED_SECRET = process.env["APPLE_SHARED_SECRET"];
const ANDROID_PACKAGE_NAME = process.env["ANDROID_PACKAGE_NAME"];

export default async (event: FunctionEvent<EventData>) => {
  try {
    // no logged in user
    if (!event.context.auth || !event.context.auth.nodeId) {
      return { error: "Login required!" };
    }

    const userId = event.context.auth.nodeId;
    const graphcool = fromEvent(event);
    const api = graphcool.api("simple/v1");

    const { receipt, purchaseToken, subscriptionId } = event.data;

    // get user by id
    const user: User = await getUser(api, userId).then(r => r.User);

    // no logged in user
    if (!user || !user.id) {
      return { error: "User not found!" };
    }

    if (receipt) {
      const body = {
        "receipt-data": receipt,
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
        const expiryDateMs = Math.max(
          ...appleResponse.latest_receipt_info.map(v =>
            parseInt(v.expires_date_ms)
          )
        );
        const expiryDate = new Date(expiryDateMs);

        const purchaseDateMs = Math.min(
          ...appleResponse.latest_receipt_info.map(v =>
            parseInt(v.purchase_date_ms)
          )
        );
        const purchaseDate = new Date(purchaseDateMs);
        const newUser = await createSubscription(
          api,
          userId,
          expiryDate.toISOString(),
          purchaseDate.toISOString(),
          purchaseDate.toISOString(),
          appleResponse.latest_receipt
        );
        if (!newUser) {
          return { error: "An error occured while restoring subscription" };
        }
      } else {
        return {
          error: "Apple responded with: " + JSON.stringify(appleResponse)
        };
      }
    } else if (purchaseToken && subscriptionId) {
      const googleData: androidpublisher_v2.Schema$SubscriptionPurchase | null = await verifyGoogle(
        subscriptionId,
        purchaseToken
      );
      if (googleData) {
        const startMillis = parseInt(googleData.startTimeMillis || "0");
        const expiryMillis = parseInt(googleData.expiryTimeMillis || "0");
        const startTime = new Date(startMillis);
        const expiryTime = new Date(expiryMillis);
        const today = new Date();
        const owner = await createSubscription(
          api,
          user.id,
          expiryTime.toISOString(),
          today.toISOString(),
          startTime.toISOString(),
          undefined,
          purchaseToken,
          subscriptionId
        );
        if (!owner) {
          return { error: "An error occured while creating Subscription." };
        }
      } else {
        return { error: "An error occured while verifying the purchase." };
      }
    } else {
      return { error: "Missing input." };
    }

    return { data: { result: true } };
  } catch (e) {
    console.log(e);
    return { error: "An unexpected error occured during subscribe." };
  }
};

async function verifyGoogle(
  subscriptionId: string,
  token: string
): Promise<androidpublisher_v2.Schema$SubscriptionPurchase | null> {
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
}

async function getUser(api: GraphQLClient, id: string): Promise<{ User }> {
  const query = `
    query getUser($id: ID!) {
      User(id: $id) {
        id
      }
    }
  `;

  const variables = {
    id
  };

  return api.request<{ User }>(query, variables);
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
