import { initializeApp } from 'firebase/app'
import { getAuth, GoogleAuthProvider } from 'firebase/auth'

const firebaseConfig = {
  apiKey: 'AIzaSyBdKPqeLcV9lbIHnF4GGVTrPoTnezw_jSU',
  authDomain: 'crmsomos-24bca.firebaseapp.com',
  projectId: 'crmsomos-24bca',
  storageBucket: 'crmsomos-24bca.firebasestorage.app',
  messagingSenderId: '656450513757',
  appId: '1:656450513757:web:1e75f724fe2eee7216d6b4',
}

const app = initializeApp(firebaseConfig)
export const auth = getAuth(app)

export const googleProvider = new GoogleAuthProvider()
googleProvider.setCustomParameters({ hd: 'somosinternet.co' })
