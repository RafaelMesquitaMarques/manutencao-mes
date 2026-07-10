import axios from 'axios';
import { useAuthStore } from '../store/authStore';
import { usePlantStore } from '../store/plantStore';

const api = axios.create({
  baseURL: '',
  headers: { 'Content-Type': 'application/json' },
});

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().token;
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  // Active plant context — validated server-side against user_plants.
  const plantId = usePlantStore.getState().activePlantId;
  if (plantId) {
    config.headers['X-Plant-Id'] = plantId;
  }
  // Kiosk access token (tablets open /machines/:slug?k=<token>; MachinePage
  // stores it). Dormant until the backend enforces KIOSK_ENFORCE_TOKEN.
  const kioskToken = sessionStorage.getItem('kaizo-kiosk-token');
  if (kioskToken) {
    config.headers['X-Kiosk-Token'] = kioskToken;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  }
);

export default api;
