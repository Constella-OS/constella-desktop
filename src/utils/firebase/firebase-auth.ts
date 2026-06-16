import {
  createUserWithEmailAndPassword,
  getAuth,
  GoogleAuthProvider,
  sendPasswordResetEmail,
  signInWithCustomToken,
  signInWithEmailAndPassword,
  signInWithPopup,
  signInWithRedirect,
} from 'firebase/auth';
import { firebaseApp } from './firebase-app';
import { LOCAL_STORAGE_KEYS } from '../local-storage';
import { getPlatform } from '../../platform/platformInstance';

export const firebaseAuth = getAuth(firebaseApp);

/**
 * Sign the Firebase SDK in using a custom token minted by our backend.
 * This establishes a durable session with a refresh token stored in the
 * SDK's local persistence, so future `currentUser.getIdToken(true)` calls
 * can silently refresh without forcing the user to log in again.
 *
 * Safe to call when already signed in as the same user — Firebase treats
 * it as a no-op sign-in for that uid.
 */
export const signInDesktopWithCustomToken = async (
  customToken: string,
): Promise<boolean> => {
  try {
    await signInWithCustomToken(firebaseAuth, customToken);
    return true;
  } catch (error) {
    console.error('[Auth:CustomToken] signInWithCustomToken failed:', error);
    return false;
  }
};

/**
 * Get current logged in userid that was stored in local storage
 */
export const getCurrentUserId = async (): Promise<string> => {
  const userId = getPlatform().storage.get(LOCAL_STORAGE_KEYS.SETTINGS.AUTH.USER_ID);
  if (!userId) return '';
  return userId;
};

/**
 * Sync version of the above. Not modifying the above one since it's used
 * in many places.
 */
export const getCurrentUserIdSync = (): string => {
  const userId = getPlatform().storage.get(LOCAL_STORAGE_KEYS.SETTINGS.AUTH.USER_ID);
  if (!userId) return '';
  return userId;
};

export const getCurrentUserEmailSync = (): string => {
  const userEmail = getPlatform().storage.get(
    LOCAL_STORAGE_KEYS.SETTINGS.AUTH.USER_EMAIL,
  );
  if (!userEmail) return '';
  return userEmail;
};

export const firebaseEmailSignUp = async (
  email: string,
  password: string,
): Promise<Record<string, any>> => {
  try {
    if (!email || !password) return { status: 'error', error: 'Empty email' };
    const user = await createUserWithEmailAndPassword(
      firebaseAuth,
      email,
      password,
    );
    return { status: 'success', userId: user.user.uid, email };
  } catch (error: any) {
    console.error('Error logging in:', error);
    let errorMessage = '';
    switch (error.code) {
      case 'auth/email-already-in-use':
        errorMessage = 'Email already in use';
        break;
      case 'auth/invalid-email':
        errorMessage = 'Invalid email';
        break;
      case 'auth/weak-password':
        errorMessage =
          'Password is too weak; please make it longer and more complex.';
        break;
      default:
        errorMessage =
          'There was an error during signup. Is the email valid and the password complex?';
    }
    throw { error: errorMessage, code: error.code };
  }
};

export const firebaseEmailLogin = async (
  email: string,
  password: string,
): Promise<Record<string, any>> => {
  try {
    if (!email || !password)
      return { status: 'error', error: 'Empty email or password' };
    const user = await signInWithEmailAndPassword(
      firebaseAuth,
      email,
      password,
    );
    return { status: 'success', userId: user.user.uid, email };
  } catch (error: any) {
    console.error('Error logging in:', error);
    return { status: 'error', error: error.message, code: error.code };
  }
};

export const firebaseGoogleAuth = async (): Promise<string> => {
  try {
    const provider = new GoogleAuthProvider();
    return signInWithRedirect(firebaseAuth, provider)
      .then(async (result) => {
        // const credential = GoogleAuthProvider.credentialFromResult(result);
        return 'Success';
      })
      .catch((error) => {
        console.error('Error logging in:', error);
        return error.message;
      });
  } catch (error: any) {
    console.error('Error logging in:', error);
    return error.message;
  }
};

export const firebaseForgotPassword = async (
  email: string,
): Promise<{ status: string; error?: string }> => {
  try {
    if (!email) return { status: 'error', error: 'Email is required' };
    await sendPasswordResetEmail(firebaseAuth, email);
    return { status: 'success' };
  } catch (error: any) {
    console.error('Error sending password reset email:', error);
    return { status: 'error', error: error.message };
  }
};
