import api from './axios';

export interface FactoryHoliday {
  id: string;
  date: string;      // ISO date
  name: string;
}

export interface FactoryCalendarSettings {
  count_weekends: boolean;
  holidays: FactoryHoliday[];
}

export const fetchCalendarSettings = async (): Promise<FactoryCalendarSettings> => {
  const { data } = await api.get<FactoryCalendarSettings>('/api/calendar/settings');
  return data;
};

export const saveCalendarSettings = async (count_weekends: boolean): Promise<FactoryCalendarSettings> => {
  const { data } = await api.put<FactoryCalendarSettings>('/api/calendar/settings', { count_weekends });
  return data;
};

export const addHoliday = async (date: string, name: string): Promise<FactoryHoliday> => {
  const { data } = await api.post<FactoryHoliday>('/api/calendar/holidays', { date, name });
  return data;
};

export const updateHoliday = async (id: string, date: string, name: string): Promise<FactoryHoliday> => {
  const { data } = await api.patch<FactoryHoliday>(`/api/calendar/holidays/${id}`, { date, name });
  return data;
};

export const deleteHoliday = async (id: string): Promise<void> => {
  await api.delete(`/api/calendar/holidays/${id}`);
};
