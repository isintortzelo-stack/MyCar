import React, { useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Animated,
  BackHandler,
  Easing,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  View
} from "react-native";
import { StatusBar } from "expo-status-bar";
import AsyncStorage from "@react-native-async-storage/async-storage";
import Constants from "expo-constants";
import * as Device from "expo-device";
import * as Notifications from "expo-notifications";
import { SafeAreaProvider, SafeAreaView } from "react-native-safe-area-context";
import Svg, { Line, Path } from "react-native-svg";

type StoredCar = {
  id: string;
  registrationNumber: string;
  nickname: string;
  insuranceExpiry: string;
  lastUpdatedAt?: string;
  isReminderTest?: boolean;
  dvla?: DvlaVehicle;
  reminders: CarReminders;
  notificationIds?: string[];
};

type DataSourceMode = "backend" | "dvla";
type ScreenName = "garage" | "addCar" | "carDetails";

type DvlaVehicle = {
  registrationNumber: string;
  taxStatus?: string;
  taxDueDate?: string;
  motStatus?: string;
  motExpiryDate?: string;
  make?: string;
  yearOfManufacture?: number;
  engineCapacity?: number;
  fuelType?: string;
  colour?: string;
};

type ReminderOffsetDays = 1 | 7 | 30;
type ReminderKind = "mot" | "roadTax" | "insurance";

type CarReminders = {
  motEnabled: boolean;
  roadTaxEnabled: boolean;
  insuranceEnabled: boolean;
  motOffsetDays: ReminderOffsetDays;
  roadTaxOffsetDays: ReminderOffsetDays;
  insuranceOffsetDays: ReminderOffsetDays;
};

const STORAGE_KEYS = {
  apiKey: "mycar.dvlaApiKey",
  cars: "mycar.cars",
  backendUrl: "mycar.backendUrl",
  dataSourceMode: "mycar.dataSourceMode"
} as const;

const DVLA_API_URL =
  "https://driver-vehicle-licensing.api.gov.uk/vehicle-enquiry/v1/vehicles";

const RENDER_BACKEND_URL = "https://mycar-backend-du9w.onrender.com";
const BACKEND_REQUEST_TIMEOUT_MS = 15000;
const STALE_BACKEND_HOSTS = new Set(["10.47.151.239"]);
const REMINDER_TEST_REGISTRATION = "TESTREM";

const DEFAULT_REMINDERS: CarReminders = {
  motEnabled: true,
  roadTaxEnabled: true,
  insuranceEnabled: true,
  motOffsetDays: 30,
  roadTaxOffsetDays: 30,
  insuranceOffsetDays: 30
};

type ScheduleCarNotificationOptions = {
  immediateKinds?: ReminderKind[];
};

const NOTIFICATIONS_SUPPORTED = true;

if (NOTIFICATIONS_SUPPORTED) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowAlert: true,
      shouldPlaySound: true,
      shouldSetBadge: false,
      shouldShowBanner: true,
      shouldShowList: true
    })
  });
}

function normalizeRegistrationNumber(input: string) {
  return input.replace(/\s+/g, "").toUpperCase();
}

function createCarId(registrationNumber: string) {
  return `${registrationNumber}-${Date.now()}`;
}

function parseManualDate(input: string) {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  const slashMatch = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    const [, dayText, monthText, yearText] = slashMatch;
    const day = Number(dayText);
    const month = Number(monthText);
    const year = Number(yearText);
    const parsed = new Date(year, month - 1, day, 9, 0, 0, 0);
    if (
      parsed.getFullYear() === year &&
      parsed.getMonth() === month - 1 &&
      parsed.getDate() === day
    ) {
      return parsed;
    }
    return null;
  }

  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  parsed.setHours(9, 0, 0, 0);
  return parsed;
}

function normalizeDateInput(input: string) {
  const parsed = parseManualDate(input);
  return parsed ? toDateInputValue(parsed) : "";
}

function subtractDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() - days);
  next.setHours(9, 0, 0, 0);
  return next;
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  next.setHours(9, 0, 0, 0);
  return next;
}

function toDateInputValue(date: Date) {
  return date.toISOString().slice(0, 10);
}

async function fetchVehicleFromDvla(
  registrationNumber: string,
  apiKey: string
): Promise<DvlaVehicle> {
  const response = await fetch(DVLA_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      "x-api-key": apiKey
    },
    body: JSON.stringify({
      registrationNumber
    })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `DVLA request failed (${response.status}). ${errorText || "No response body."}`
    );
  }

  return (await response.json()) as DvlaVehicle;
}

async function fetchVehicleFromBackend(
  registrationNumber: string,
  backendUrl: string
): Promise<DvlaVehicle> {
  const normalizedBaseUrl = backendUrl.trim().replace(/\/+$/, "");
  const abortController = new AbortController();
  const timeoutId = setTimeout(
    () => abortController.abort(),
    BACKEND_REQUEST_TIMEOUT_MS
  );

  let response: Response;

  try {
    response = await fetch(`${normalizedBaseUrl}/vehicle`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json"
      },
      body: JSON.stringify({
        registrationNumber
      }),
      signal: abortController.signal
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(
        `Backend request timed out after ${BACKEND_REQUEST_TIMEOUT_MS / 1000} seconds. Check the backend is running and the phone is on the same Wi-Fi.`
      );
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const errorText = await response.text();
    const parsedError = tryExtractErrorMessage(errorText);
    throw new Error(
      `Backend request failed (${response.status}). ${parsedError || errorText || "No response body."}`
    );
  }

  const payload = (await response.json()) as {
    vehicle?: DvlaVehicle;
  };

  if (!payload.vehicle) {
    throw new Error("Backend returned no vehicle payload");
  }

  return payload.vehicle;
}

function formatDate(value?: string) {
  if (!value) {
    return "Unknown";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  const months = [
    "Jan",
    "Feb",
    "Mar",
    "Apr",
    "May",
    "Jun",
    "Jul",
    "Aug",
    "Sep",
    "Oct",
    "Nov",
    "Dec"
  ];

  return `${String(date.getDate()).padStart(2, "0")} ${months[date.getMonth()]} ${date.getFullYear()}`;
}

function formatReminderLabel(days: ReminderOffsetDays) {
  if (days === 1) {
    return "1 day before";
  }

  return `${days} days before`;
}

function formatDueMessage(label: string, eventDate: Date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueDate = new Date(eventDate);
  dueDate.setHours(0, 0, 0, 0);

  const daysUntil = Math.ceil(
    (dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)
  );

  if (daysUntil < 0) {
    return `${label} is overdue.`;
  }

  if (daysUntil === 0) {
    return `${label} is due today.`;
  }

  if (daysUntil === 1) {
    return `${label} is due in 1 day.`;
  }

  return `${label} is due in ${daysUntil} days.`;
}

function getWholeDaysUntil(eventDate: Date) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const dueDate = new Date(eventDate);
  dueDate.setHours(0, 0, 0, 0);

  return Math.ceil(
    (dueDate.getTime() - today.getTime()) / (24 * 60 * 60 * 1000)
  );
}

async function registerForNotifications() {
  if (!NOTIFICATIONS_SUPPORTED) {
    return false;
  }

  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("reminders", {
        name: "Reminders",
        importance: Notifications.AndroidImportance.HIGH,
        sound: "default",
        vibrationPattern: [0, 250, 250, 250]
      });
    }

    if (!Device.isDevice) {
      return false;
    }

    const currentPermissions = await Notifications.getPermissionsAsync();
    if ((currentPermissions as { status?: string }).status === "granted") {
      return true;
    }

    const requestedPermissions = await Notifications.requestPermissionsAsync();
    return (requestedPermissions as { status?: string }).status === "granted";
  } catch {
    return false;
  }
}

async function cancelCarNotifications(car: StoredCar) {
  if (!NOTIFICATIONS_SUPPORTED) {
    return;
  }

  await Promise.all(
    (car.notificationIds || []).map((notificationId) =>
      Notifications.cancelScheduledNotificationAsync(notificationId)
    )
  );
}

async function scheduleCarNotifications(
  car: StoredCar,
  options: ScheduleCarNotificationOptions = {}
) {
  await cancelCarNotifications(car);

  const hasPermissions = await registerForNotifications();
  const notificationIds: string[] = [];
  const immediateKinds = new Set(options.immediateKinds || []);

  async function scheduleOne(
    kind: ReminderKind,
    title: string,
    label: string,
    eventDate: Date | null,
    offsetDays: ReminderOffsetDays
  ) {
    if (!eventDate) {
      return;
    }

    if (Number.isNaN(eventDate.getTime())) {
      return;
    }

    const body = `${formatDueMessage(label, eventDate)} ${formatDate(
      eventDate.toISOString()
    )}`;
    const triggerDate = subtractDays(eventDate, offsetDays);
    if (!hasPermissions) {
      return;
    }

    if (getWholeDaysUntil(eventDate) <= offsetDays) {
      if (!immediateKinds.has(kind)) {
        return;
      }

      await Notifications.scheduleNotificationAsync({
        content: {
          title,
          body,
          sound: "default"
        },
        trigger: {
          type: Notifications.SchedulableTriggerInputTypes.TIME_INTERVAL,
          seconds: 1,
          channelId: "reminders"
        }
      });
      return;
    }

    const notificationId = await Notifications.scheduleNotificationAsync({
      content: {
        title,
        body,
        sound: "default"
      },
      trigger: {
        type: Notifications.SchedulableTriggerInputTypes.DATE,
        channelId: "reminders",
        date: triggerDate
      }
    });

    notificationIds.push(notificationId);
  }

  if (car.reminders.motEnabled) {
    await scheduleOne(
      "mot",
      `${car.registrationNumber} MOT reminder`,
      "MOT",
      car.dvla?.motExpiryDate ? new Date(car.dvla.motExpiryDate) : null,
      car.reminders.motOffsetDays
    );
  }

  if (car.reminders.roadTaxEnabled) {
    await scheduleOne(
      "roadTax",
      `${car.registrationNumber} road tax reminder`,
      "Road tax",
      car.dvla?.taxDueDate ? new Date(car.dvla.taxDueDate) : null,
      car.reminders.roadTaxOffsetDays
    );
  }

  if (car.reminders.insuranceEnabled) {
    await scheduleOne(
      "insurance",
      `${car.registrationNumber} insurance reminder`,
      "Insurance",
      parseManualDate(car.insuranceExpiry),
      car.reminders.insuranceOffsetDays
    );
  }

  return notificationIds;
}

function Field({
  label,
  value,
  onChangeText,
  placeholder,
  autoCapitalize = "sentences"
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  autoCapitalize?: "none" | "sentences" | "words" | "characters";
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.label}>{label}</Text>
      <TextInput
        autoCapitalize={autoCapitalize}
        placeholder={placeholder}
        placeholderTextColor="#6b7280"
        style={styles.input}
        value={value}
        onChangeText={onChangeText}
      />
    </View>
  );
}

function Section({
  title,
  children
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

function DetailRow({
  label,
  value,
  valueStyle
}: {
  label: string;
  value: string;
  valueStyle?: object;
}) {
  return (
    <View style={styles.detailRow}>
      <Text style={styles.detailLabel}>{label}</Text>
      <Text style={[styles.detailValue, valueStyle]}>{value}</Text>
    </View>
  );
}

function PenEditIcon() {
  return (
    <Svg width={28} height={28} viewBox="0 0 28 28" fill="none">
      <Path
        d="M7.2 19.7L18.5 8.4C19.2 7.7 20.4 7.7 21.1 8.4L22.5 9.8C23.2 10.5 23.2 11.7 22.5 12.4L11.2 23.7L5.4 25.1L7.2 19.7Z"
        stroke="#F8FAFC"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M17.1 9.8L21.1 13.8"
        stroke="#F8FAFC"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M7.2 19.7L11.2 23.7"
        stroke="#F8FAFC"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Line
        x1="4.8"
        y1="25.2"
        x2="14.3"
        y2="25.2"
        stroke="#F8FAFC"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Line
        x1="20"
        y1="6.9"
        x2="24"
        y2="10.9"
        stroke="#F8FAFC"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function AddCarIcon() {
  return (
    <Svg width={30} height={30} viewBox="0 0 30 30" fill="none">
      <Path
        d="M6 17.5L8.4 11.8C8.8 10.9 9.7 10.3 10.7 10.3H17.7C18.7 10.3 19.6 10.9 20 11.8L22.4 17.5"
        stroke="#111827"
        strokeWidth={2.2}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M5.5 17.5H22.9V22.1H5.5V17.5Z"
        stroke="#111827"
        strokeWidth={2.2}
        strokeLinejoin="round"
      />
      <Line
        x1="9"
        y1="22.3"
        x2="9"
        y2="23.4"
        stroke="#111827"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Line
        x1="19.4"
        y1="22.3"
        x2="19.4"
        y2="23.4"
        stroke="#111827"
        strokeWidth={2.2}
        strokeLinecap="round"
      />
      <Line
        x1="24.8"
        y1="6.4"
        x2="24.8"
        y2="12.4"
        stroke="#111827"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
      <Line
        x1="21.8"
        y1="9.4"
        x2="27.8"
        y2="9.4"
        stroke="#111827"
        strokeWidth={2.4}
        strokeLinecap="round"
      />
    </Svg>
  );
}

function RefreshArrowsIcon() {
  return (
    <Svg width={27} height={27} viewBox="0 0 27 27" fill="none">
      <Path
        d="M20.8 10.8C19.8 7.9 17.1 5.8 13.8 5.8C11.2 5.8 8.9 7.2 7.6 9.3"
        stroke="#F8FAFC"
        strokeWidth={2.3}
        strokeLinecap="round"
      />
      <Path
        d="M20.7 6.6L20.9 10.9L16.6 11.1"
        stroke="#F8FAFC"
        strokeWidth={2.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <Path
        d="M6.2 16.2C7.2 19.1 9.9 21.2 13.2 21.2C15.8 21.2 18.1 19.8 19.4 17.7"
        stroke="#F8FAFC"
        strokeWidth={2.3}
        strokeLinecap="round"
      />
      <Path
        d="M6.3 20.4L6.1 16.1L10.4 15.9"
        stroke="#F8FAFC"
        strokeWidth={2.3}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </Svg>
  );
}

function getDisplayVehicleName(car: StoredCar) {
  const make = car.dvla?.make || "";
  return make || "Unknown";
}

function ToggleRow({
  label,
  value,
  onValueChange,
  children
}: {
  label: string;
  value: boolean;
  onValueChange: (value: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <View style={styles.toggleRow}>
      <Text style={styles.toggleLabel}>{label}</Text>
      <View style={styles.toggleControls}>
        {children}
        <Switch value={value} onValueChange={onValueChange} />
      </View>
    </View>
  );
}

function ReminderOffsetControl({
  value,
  onChange
}: {
  value: ReminderOffsetDays;
  onChange: (value: ReminderOffsetDays) => void;
}) {
  return (
    <View style={styles.reminderOffsetControl}>
      {[1, 7, 30].map((days, index) => {
        const selected = value === days;
        return (
          <Pressable
            key={days}
            style={[
              styles.reminderOffsetSegment,
              selected && styles.reminderOffsetSegmentSelected
            ]}
            onPress={() => onChange(days as ReminderOffsetDays)}
          >
            <Text
              style={[
                styles.reminderOffsetText,
                selected && styles.reminderOffsetTextSelected
              ]}
            >
              {days}d
            </Text>
            {index < 2 ? <View style={styles.reminderOffsetDivider} /> : null}
          </Pressable>
        );
      })}
    </View>
  );
}

function getErrorMessage(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unexpected error";
}

function tryExtractErrorMessage(value: string) {
  try {
    const parsed = JSON.parse(value) as { error?: string };
    return parsed.error || "";
  } catch {
    return "";
  }
}

function getExpoLanBackendUrl() {
  const linkingUri = Constants.linkingUri || "";
  const hostMatch = linkingUri.match(/^[a-z]+:\/\/([^/:]+)/i);
  const host = hostMatch?.[1] || "";

  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) {
    return "";
  }

  return `http://${host}:4000`;
}

function isStaleBackendUrl(value: string) {
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "http:" ||
      STALE_BACKEND_HOSTS.has(parsed.hostname) ||
      /^\d{1,3}(\.\d{1,3}){3}$/.test(parsed.hostname)
    );
  } catch {
    return false;
  }
}

function normalizeReminders(
  reminders?: Partial<CarReminders> & { offsetDays?: ReminderOffsetDays }
): CarReminders {
  const fallbackOffset = reminders?.offsetDays || 30;

  return {
    motEnabled: reminders?.motEnabled ?? DEFAULT_REMINDERS.motEnabled,
    roadTaxEnabled:
      reminders?.roadTaxEnabled ?? DEFAULT_REMINDERS.roadTaxEnabled,
    insuranceEnabled:
      reminders?.insuranceEnabled ?? DEFAULT_REMINDERS.insuranceEnabled,
    motOffsetDays: reminders?.motOffsetDays || fallbackOffset,
    roadTaxOffsetDays: reminders?.roadTaxOffsetDays || fallbackOffset,
    insuranceOffsetDays: reminders?.insuranceOffsetDays || fallbackOffset
  };
}

function App() {
  const autoBackendUrl = getExpoLanBackendUrl();
  const defaultBackendUrl = RENDER_BACKEND_URL || autoBackendUrl;
  const [loading, setLoading] = useState(true);
  const [screen, setScreen] = useState<ScreenName>("garage");
  const [selectedCarId, setSelectedCarId] = useState<string | null>(null);
  const [apiKeyInput, setApiKeyInput] = useState("");
  const [savedApiKey, setSavedApiKey] = useState("");
  const [backendUrlInput, setBackendUrlInput] = useState(defaultBackendUrl);
  const [savedBackendUrl, setSavedBackendUrl] = useState("");
  const [dataSourceMode, setDataSourceMode] = useState<DataSourceMode>("backend");
  const [cars, setCars] = useState<StoredCar[]>([]);
  const [refreshingId, setRefreshingId] = useState<string | null>(null);
  const refreshSpinValue = useRef(new Animated.Value(0)).current;
  const [notificationsReady, setNotificationsReady] = useState(false);
  const [registrationInput, setRegistrationInput] = useState("");
  const [nicknameInput, setNicknameInput] = useState("");
  const [insuranceExpiryInput, setInsuranceExpiryInput] = useState("");
  const [testMotExpiryInput, setTestMotExpiryInput] = useState("");
  const [testRoadTaxInput, setTestRoadTaxInput] = useState("");
  const [testInsuranceInput, setTestInsuranceInput] = useState("");
  const [testReminderStatus, setTestReminderStatus] = useState("");
  const [editModalVisible, setEditModalVisible] = useState(false);
  const selectedCar = cars.find((car) => car.id === selectedCarId) || null;

  useEffect(() => {
    void loadStoredState();
  }, []);

  useEffect(() => {
    if (screen === "carDetails" && !selectedCar) {
      setScreen("garage");
    }
  }, [screen, selectedCar]);

  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      "hardwareBackPress",
      () => {
        if (editModalVisible) {
          setEditModalVisible(false);
          return true;
        }

        if (screen !== "garage") {
          setScreen("garage");
          return true;
        }

        return false;
      }
    );

    return () => subscription.remove();
  }, [editModalVisible, screen]);

  useEffect(() => {
    refreshSpinValue.setValue(0);

    if (!refreshingId) {
      return;
    }

    const animation = Animated.loop(
      Animated.timing(refreshSpinValue, {
        toValue: 1,
        duration: 850,
        easing: Easing.linear,
        useNativeDriver: true
      })
    );

    animation.start();

    return () => animation.stop();
  }, [refreshingId, refreshSpinValue]);

  async function loadStoredState() {
    try {
      const [apiKey, carsJson, backendUrl, storedDataSourceMode] = await Promise.all([
        AsyncStorage.getItem(STORAGE_KEYS.apiKey),
        AsyncStorage.getItem(STORAGE_KEYS.cars),
        AsyncStorage.getItem(STORAGE_KEYS.backendUrl),
        AsyncStorage.getItem(STORAGE_KEYS.dataSourceMode)
      ]);

      if (apiKey) {
        setSavedApiKey(apiKey);
        setApiKeyInput(apiKey);
      }

      if (backendUrl && !isStaleBackendUrl(backendUrl)) {
        setSavedBackendUrl(backendUrl);
        setBackendUrlInput(backendUrl);
      } else if (defaultBackendUrl) {
        await AsyncStorage.setItem(STORAGE_KEYS.backendUrl, defaultBackendUrl);
        setSavedBackendUrl(defaultBackendUrl);
        setBackendUrlInput(defaultBackendUrl);
      }

      if (
        storedDataSourceMode === "backend" ||
        storedDataSourceMode === "dvla"
      ) {
        setDataSourceMode(storedDataSourceMode);
      }

      if (carsJson) {
        setCars(
          (JSON.parse(carsJson) as StoredCar[]).map((car) => ({
            ...car,
            reminders: normalizeReminders(car.reminders),
            notificationIds: car.notificationIds || []
          }))
        );
      }

      const hasPermissions = await registerForNotifications();
      setNotificationsReady(hasPermissions);
    } catch (error) {
      Alert.alert("Storage error", getErrorMessage(error));
    } finally {
      setLoading(false);
    }
  }

  async function persistCars(nextCars: StoredCar[]) {
    setCars(nextCars);
    await AsyncStorage.setItem(STORAGE_KEYS.cars, JSON.stringify(nextCars));
  }

  async function saveApiKey() {
    const trimmedKey = apiKeyInput.trim();
    await AsyncStorage.setItem(STORAGE_KEYS.apiKey, trimmedKey);
    setSavedApiKey(trimmedKey);
    Alert.alert("Saved", "DVLA API key saved on this device.");
  }

  async function saveBackendSettings() {
    const trimmedBackendUrl = backendUrlInput.trim().replace(/\/+$/, "");

    await AsyncStorage.multiSet([
      [STORAGE_KEYS.backendUrl, trimmedBackendUrl],
      [STORAGE_KEYS.dataSourceMode, dataSourceMode]
    ]);

    setSavedBackendUrl(trimmedBackendUrl);
    Alert.alert("Saved", "Backend settings saved on this device.");
  }

  async function addCar() {
    const registrationNumber = normalizeRegistrationNumber(registrationInput);
    if (!registrationNumber) {
      Alert.alert("Missing registration", "Enter a registration number first.");
      return;
    }

    if (cars.some((car) => car.registrationNumber === registrationNumber)) {
      Alert.alert("Already added", "That car is already saved.");
      return;
    }

    const nextCar: StoredCar = {
      id: createCarId(registrationNumber),
      registrationNumber,
      nickname: nicknameInput.trim(),
      insuranceExpiry: insuranceExpiryInput.trim(),
      reminders: { ...DEFAULT_REMINDERS },
      notificationIds: []
    };

    const nextCars = [nextCar, ...cars];
    await persistCars(nextCars);

    setRegistrationInput("");
    setNicknameInput("");
    setInsuranceExpiryInput("");
    setScreen("garage");
    setSelectedCarId(nextCar.id);

    if (
      (dataSourceMode === "dvla" && savedApiKey) ||
      (dataSourceMode === "backend" && (savedBackendUrl || defaultBackendUrl))
    ) {
      await refreshCar(nextCar.id, nextCars);
    }
  }

  async function addReminderTestCar() {
    const today = new Date();
    const motExpiryDate = toDateInputValue(addDays(today, 7));
    const taxDueDate = toDateInputValue(addDays(today, 14));
    const insuranceExpiry = toDateInputValue(addDays(today, 21));
    const existingTestCar = cars.find(
      (car) => car.registrationNumber === REMINDER_TEST_REGISTRATION
    );

    if (existingTestCar) {
      openCarDetails(existingTestCar.id);
      return;
    }

    const nextCar: StoredCar = {
      id: createCarId(REMINDER_TEST_REGISTRATION),
      registrationNumber: REMINDER_TEST_REGISTRATION,
      nickname: "Reminder test",
      insuranceExpiry,
      isReminderTest: true,
      lastUpdatedAt: new Date().toISOString(),
      dvla: {
        registrationNumber: REMINDER_TEST_REGISTRATION,
        make: "TEST",
        colour: "GREY",
        fuelType: "PETROL",
        yearOfManufacture: 2026,
        taxStatus: "Taxed",
        taxDueDate,
        motStatus: "Valid",
        motExpiryDate
      },
      reminders: { ...DEFAULT_REMINDERS },
      notificationIds: []
    };

    await persistCars([nextCar, ...cars]);
    setRegistrationInput("");
    setNicknameInput("");
    setInsuranceExpiryInput("");
    setTestMotExpiryInput(motExpiryDate);
    setTestRoadTaxInput(taxDueDate);
    setTestInsuranceInput(insuranceExpiry);
    setSelectedCarId(nextCar.id);
    setScreen("carDetails");
  }

  async function removeCar(id: string) {
    const carToRemove = cars.find((car) => car.id === id);
    if (carToRemove) {
      await cancelCarNotifications(carToRemove);
    }
    const nextCars = cars.filter((car) => car.id !== id);
    await persistCars(nextCars);

    if (selectedCarId === id) {
      setSelectedCarId(null);
      setScreen("garage");
    }
  }

  async function refreshCar(id: string, baseCars = cars) {
    const effectiveBackendUrl = savedBackendUrl || defaultBackendUrl;

    if (dataSourceMode === "dvla" && !savedApiKey) {
      Alert.alert("Missing API key", "Save your DVLA API key before refreshing.");
      return;
    }

    if (dataSourceMode === "backend" && !effectiveBackendUrl) {
      Alert.alert(
        "Backend unavailable",
        "The hosted backend URL is not configured."
      );
      return;
    }

    const car = baseCars.find((item) => item.id === id);
    if (!car) {
      return;
    }

    setRefreshingId(id);

    try {
      const dvla =
        dataSourceMode === "backend"
          ? await fetchVehicleFromBackend(
              car.registrationNumber,
              effectiveBackendUrl
            )
          : await fetchVehicleFromDvla(car.registrationNumber, savedApiKey);
      const refreshedCars = baseCars.map((item) =>
        item.id === id
          ? {
              ...item,
              dvla,
              lastUpdatedAt: new Date().toISOString()
            }
          : item
      );
      const refreshedCar = refreshedCars.find((item) => item.id === id);
      if (!refreshedCar) {
        return;
      }

      const notificationIds = await scheduleCarNotifications(refreshedCar);
      const nextCars = refreshedCars.map((item) =>
        item.id === id
          ? {
              ...item,
              notificationIds
            }
          : item
      );

      await persistCars(nextCars);
    } catch (error) {
      Alert.alert("Refresh failed", getErrorMessage(error));
    } finally {
      setRefreshingId((current) => (current === id ? null : current));
    }
  }

  async function updateCar(
    id: string,
    updater: (car: StoredCar) => StoredCar,
    notificationOptions?: ScheduleCarNotificationOptions
  ) {
    const existingCar = cars.find((car) => car.id === id);
    if (!existingCar) {
      return;
    }

    const updatedCar = updater(existingCar);
    const notificationIds = await scheduleCarNotifications(
      updatedCar,
      notificationOptions
    );
    const nextCars = cars.map((car) =>
      car.id === id
        ? {
            ...updatedCar,
            notificationIds
          }
        : car
    );
    await persistCars(nextCars);
  }

  function openCarDetails(carId: string) {
    const car = cars.find((item) => item.id === carId);
    setSelectedCarId(carId);
    setNicknameInput(car?.nickname || "");
    setInsuranceExpiryInput(car?.insuranceExpiry || "");
    setTestMotExpiryInput(car?.dvla?.motExpiryDate || "");
    setTestRoadTaxInput(car?.dvla?.taxDueDate || "");
    setTestInsuranceInput(car?.insuranceExpiry || "");
    setTestReminderStatus("");
    setScreen("carDetails");
  }

  function openAddCar() {
    setRegistrationInput("");
    setNicknameInput("");
    setInsuranceExpiryInput("");
    setTestReminderStatus("");
    setScreen("addCar");
  }

  async function saveCarDetails() {
    if (!selectedCar) {
      return;
    }

    const insuranceExpiry = insuranceExpiryInput.trim();
    const immediateKinds =
      insuranceExpiry !== selectedCar.insuranceExpiry ? ["insurance" as const] : [];

    await updateCar(
      selectedCar.id,
      (current) => ({
        ...current,
        nickname: nicknameInput.trim(),
        insuranceExpiry
      }),
      { immediateKinds }
    );
    Alert.alert("Saved", "Car details updated.");
  }

  async function saveTestReminderDates() {
    if (!selectedCar?.isReminderTest) {
      return;
    }

    const motExpiryDate = normalizeDateInput(testMotExpiryInput);
    const taxDueDate = normalizeDateInput(testRoadTaxInput);
    const insuranceExpiry = normalizeDateInput(testInsuranceInput);

    if (!motExpiryDate || !taxDueDate || !insuranceExpiry) {
      Alert.alert("Invalid date", "Use dates like 23/06/2026 or 2026-06-23.");
      return;
    }

    const immediateKinds: ReminderKind[] = [];
    if (motExpiryDate !== selectedCar.dvla?.motExpiryDate) {
      immediateKinds.push("mot");
    }
    if (taxDueDate !== selectedCar.dvla?.taxDueDate) {
      immediateKinds.push("roadTax");
    }
    if (insuranceExpiry !== selectedCar.insuranceExpiry) {
      immediateKinds.push("insurance");
    }

    await updateCar(
      selectedCar.id,
      (current) => ({
        ...current,
        insuranceExpiry,
        lastUpdatedAt: new Date().toISOString(),
        dvla: {
          ...(current.dvla || {
            registrationNumber: current.registrationNumber
          }),
          registrationNumber: current.registrationNumber,
          taxDueDate,
          motExpiryDate
        }
      }),
      { immediateKinds }
    );

    setTestMotExpiryInput(motExpiryDate);
    setTestRoadTaxInput(taxDueDate);
    setTestInsuranceInput(insuranceExpiry);
    setTestReminderStatus("Test dates saved. Reminder notifications updated.");

  }

  if (loading) {
    return (
      <SafeAreaProvider>
        <SafeAreaView style={styles.loadingScreen}>
          <StatusBar style="light" />
          <ActivityIndicator size="large" color="#f59e0b" />
        </SafeAreaView>
      </SafeAreaProvider>
    );
  }

  const refreshSpin = refreshSpinValue.interpolate({
    inputRange: [0, 1],
    outputRange: ["0deg", "360deg"]
  });

  return (
    <SafeAreaProvider>
      <SafeAreaView style={styles.screen}>
        <StatusBar style="light" />
        <View style={styles.topBar}>
          {screen !== "garage" ? (
            <Pressable style={styles.backButton} onPress={() => setScreen("garage")}>
              <Text style={styles.backButtonText}>Back</Text>
            </Pressable>
          ) : (
            <View style={styles.backButtonSpacer} />
          )}
          <Text style={styles.topBarTitle}>
            {screen === "garage"
              ? "MyCar"
              : screen === "addCar"
                ? "Add Car"
                : "Car Details"}
          </Text>
          <View style={styles.backButtonSpacer} />
        </View>

        {screen === "garage" ? (
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.hero}>
              <View style={styles.heroTitleRow}>
                <Text style={styles.title}>My Garage</Text>
                <Pressable
                  accessibilityLabel="Add car"
                  style={styles.addCarIconButton}
                  onPress={openAddCar}
                >
                  <AddCarIcon />
                </Pressable>
              </View>
            </View>

            <View style={styles.garageList}>
              {cars.length === 0 ? (
                <Text style={styles.emptyState}>
                  No cars saved yet. Add a registration to start building your garage.
                </Text>
              ) : (
                cars.map((car) => {
                  const isRefreshing = refreshingId === car.id;

                  return (
                    <Pressable
                      key={car.id}
                      style={styles.carCard}
                      onPress={() => openCarDetails(car.id)}
                    >
                      <View style={styles.cardHeader}>
                        <View>
                          <Text style={styles.regPlate}>{car.registrationNumber}</Text>
                          <Text style={styles.cardMeta}>
                            {car.nickname || ""}
                          </Text>
                        </View>
                        {car.isReminderTest ? null : (
                          <Pressable
                            accessibilityLabel="Refresh vehicle data"
                            style={styles.refreshIconButton}
                            disabled={isRefreshing}
                            onPress={(event) => {
                              event.stopPropagation();
                              void refreshCar(car.id);
                            }}
                          >
                            <Animated.View
                              style={[
                                styles.refreshIconSpin,
                                isRefreshing && {
                                  transform: [{ rotate: refreshSpin }]
                                }
                              ]}
                            >
                              <RefreshArrowsIcon />
                            </Animated.View>
                          </Pressable>
                        )}
                      </View>

                      <View style={styles.detailGrid}>
                        <DetailRow label="Vehicle" value={getDisplayVehicleName(car)} />
                        <DetailRow
                          label="MOT"
                          value={formatDate(car.dvla?.motExpiryDate)}
                        />
                        <DetailRow
                          label="Road Tax"
                          value={formatDate(car.dvla?.taxDueDate)}
                        />
                        <DetailRow
                          label="Insurance"
                          value={
                            car.insuranceExpiry
                              ? formatDate(car.insuranceExpiry)
                              : "Not set"
                          }
                          valueStyle={
                            car.insuranceExpiry ? undefined : styles.notSetValue
                          }
                        />
                      </View>

                    </Pressable>
                  );
                })
              )}
            </View>
          </ScrollView>
        ) : null}

        {screen === "addCar" ? (
          <ScrollView contentContainerStyle={styles.content}>
            <Section title="Add Car">
              <Field
                label="Registration"
                value={registrationInput}
                onChangeText={setRegistrationInput}
                placeholder="AB12CDE"
                autoCapitalize="characters"
              />
              <Field
                label="Nickname"
                value={nicknameInput}
                onChangeText={setNicknameInput}
                placeholder="Golf GTI"
              />
              <Field
                label="Insurance expiry"
                value={insuranceExpiryInput}
                onChangeText={setInsuranceExpiryInput}
                placeholder="31/12/2026"
              />
              <Pressable style={styles.primaryButton} onPress={() => void addCar()}>
                <Text style={styles.primaryButtonText}>Save car</Text>
              </Pressable>
              <Pressable
                style={styles.secondaryButton}
                onPress={() => void addReminderTestCar()}
              >
                <Text style={styles.secondaryButtonText}>Add reminder test car</Text>
              </Pressable>
            </Section>
          </ScrollView>
        ) : null}

        {screen === "carDetails" && selectedCar ? (
          <ScrollView contentContainerStyle={styles.content}>
            <View style={styles.carCard}>
              <View style={styles.regHeaderRow}>
                <Text style={styles.regPlate}>{selectedCar.registrationNumber}</Text>
                <Pressable
                  style={styles.iconButton}
                  onPress={() => setEditModalVisible(true)}
                >
                  <PenEditIcon />
                </Pressable>
              </View>
              <Text style={styles.cardMeta}>{selectedCar.nickname || ""}</Text>
              <Text style={styles.updatedText}>
                Last updated:{" "}
                {selectedCar.lastUpdatedAt
                  ? formatDate(selectedCar.lastUpdatedAt)
                  : "Never"}
              </Text>
            </View>

            <Section title="Vehicle Details">
              <View style={styles.detailGrid}>
                <DetailRow label="Vehicle" value={getDisplayVehicleName(selectedCar)} />
                <DetailRow
                  label="Year"
                  value={
                    selectedCar.dvla?.yearOfManufacture
                      ? String(selectedCar.dvla.yearOfManufacture)
                      : "Unknown"
                  }
                />
                <DetailRow
                  label="MOT"
                  value={formatDate(selectedCar.dvla?.motExpiryDate)}
                />
                <DetailRow
                  label="Road Tax"
                  value={formatDate(selectedCar.dvla?.taxDueDate)}
                />
                <DetailRow
                  label="Insurance"
                  value={
                    selectedCar.insuranceExpiry
                      ? formatDate(selectedCar.insuranceExpiry)
                      : "Not set"
                  }
                  valueStyle={
                    selectedCar.insuranceExpiry ? undefined : styles.notSetValue
                  }
                />
                <DetailRow label="Fuel" value={selectedCar.dvla?.fuelType || "Unknown"} />
                <DetailRow label="Colour" value={selectedCar.dvla?.colour || "Unknown"} />
              </View>
            </Section>

            {selectedCar.isReminderTest ? (
              <Section title="Test Reminder Dates">
                <Field
                  label="MOT date"
                  value={testMotExpiryInput}
                  onChangeText={setTestMotExpiryInput}
                  placeholder="2026-12-31"
                />
                <Field
                  label="Road tax date"
                  value={testRoadTaxInput}
                  onChangeText={setTestRoadTaxInput}
                  placeholder="2026-12-31"
                />
                <Field
                  label="Insurance date"
                  value={testInsuranceInput}
                  onChangeText={setTestInsuranceInput}
                  placeholder="2026-12-31"
                />
                <Pressable
                  style={styles.primaryButton}
                  onPress={() => void saveTestReminderDates()}
                >
                  <Text style={styles.primaryButtonText}>Save test dates</Text>
                </Pressable>
                {testReminderStatus ? (
                  <Text style={styles.helperText}>{testReminderStatus}</Text>
                ) : null}
              </Section>
            ) : null}

            <Section title="Reminders">
              <ToggleRow
                label="MOT"
                value={selectedCar.reminders.motEnabled}
                onValueChange={(value) =>
                  void updateCar(
                    selectedCar.id,
                    (current) => ({
                      ...current,
                      reminders: {
                        ...current.reminders,
                        motEnabled: value
                      }
                    }),
                    { immediateKinds: value ? ["mot"] : [] }
                  )
                }
              >
                <ReminderOffsetControl
                  value={selectedCar.reminders.motOffsetDays}
                  onChange={(days) =>
                    void updateCar(
                      selectedCar.id,
                      (current) => ({
                        ...current,
                        reminders: {
                          ...current.reminders,
                          motOffsetDays: days
                        }
                      }),
                      { immediateKinds: ["mot"] }
                    )
                  }
                />
              </ToggleRow>
              <ToggleRow
                label="Road Tax"
                value={selectedCar.reminders.roadTaxEnabled}
                onValueChange={(value) =>
                  void updateCar(
                    selectedCar.id,
                    (current) => ({
                      ...current,
                      reminders: {
                        ...current.reminders,
                        roadTaxEnabled: value
                      }
                    }),
                    { immediateKinds: value ? ["roadTax"] : [] }
                  )
                }
              >
                <ReminderOffsetControl
                  value={selectedCar.reminders.roadTaxOffsetDays}
                  onChange={(days) =>
                    void updateCar(
                      selectedCar.id,
                      (current) => ({
                        ...current,
                        reminders: {
                          ...current.reminders,
                          roadTaxOffsetDays: days
                        }
                      }),
                      { immediateKinds: ["roadTax"] }
                    )
                  }
                />
              </ToggleRow>
              <ToggleRow
                label="Insurance"
                value={selectedCar.reminders.insuranceEnabled}
                onValueChange={(value) =>
                  void updateCar(
                    selectedCar.id,
                    (current) => ({
                      ...current,
                      reminders: {
                        ...current.reminders,
                        insuranceEnabled: value
                      }
                    }),
                    { immediateKinds: value ? ["insurance"] : [] }
                  )
                }
              >
                <ReminderOffsetControl
                  value={selectedCar.reminders.insuranceOffsetDays}
                  onChange={(days) =>
                    void updateCar(
                      selectedCar.id,
                      (current) => ({
                        ...current,
                        reminders: {
                          ...current.reminders,
                          insuranceOffsetDays: days
                        }
                      }),
                      { immediateKinds: ["insurance"] }
                    )
                  }
                />
              </ToggleRow>
            </Section>

            {!selectedCar.isReminderTest ? (
              <Pressable
                style={styles.primaryButton}
                onPress={() => void refreshCar(selectedCar.id)}
              >
                <Text style={styles.primaryButtonText}>
                  {refreshingId === selectedCar.id
                    ? "Refreshing..."
                    : "Refresh vehicle data"}
                </Text>
              </Pressable>
            ) : null}
            <Modal
              animationType="fade"
              transparent
              visible={editModalVisible}
              onRequestClose={() => setEditModalVisible(false)}
            >
              <View style={styles.modalOverlay}>
                <View style={styles.modalCard}>
                  <Text style={styles.sectionTitle}>Edit Car</Text>
                  <Field
                    label="Nickname"
                    value={nicknameInput}
                    onChangeText={setNicknameInput}
                  />
                  <Field
                    label="Insurance"
                    value={insuranceExpiryInput}
                    onChangeText={setInsuranceExpiryInput}
                    placeholder="31/12/2026"
                  />
                  <View style={styles.cardActions}>
                    <Pressable
                      style={styles.secondaryButton}
                      onPress={async () => {
                        await saveCarDetails();
                        setEditModalVisible(false);
                      }}
                    >
                      <Text style={styles.secondaryButtonText}>Save changes</Text>
                    </Pressable>
                    <Pressable
                      style={styles.ghostButton}
                      onPress={() => setEditModalVisible(false)}
                    >
                      <Text style={styles.ghostButtonText}>Cancel</Text>
                    </Pressable>
                    <Pressable
                      style={styles.ghostButton}
                      onPress={async () => {
                        await removeCar(selectedCar.id);
                        setEditModalVisible(false);
                      }}
                    >
                      <Text style={styles.ghostButtonText}>Remove</Text>
                    </Pressable>
                  </View>
                </View>
              </View>
            </Modal>
          </ScrollView>
        ) : null}
      </SafeAreaView>
    </SafeAreaProvider>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: "#0b1220"
  },
  loadingScreen: {
    flex: 1,
    backgroundColor: "#0b1220",
    alignItems: "center",
    justifyContent: "center"
  },
  topBar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: 16,
    paddingTop: 8,
    paddingBottom: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#172033"
  },
  topBarTitle: {
    color: "#f59e0b",
    fontSize: 18,
    fontWeight: "700"
  },
  backButton: {
    minWidth: 56
  },
  backButtonSpacer: {
    minWidth: 56
  },
  backButtonText: {
    color: "#f59e0b",
    fontWeight: "700"
  },
  content: {
    padding: 20,
    gap: 18
  },
  hero: {
    paddingTop: 12,
    gap: 8
  },
  heroTitleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 14
  },
  eyebrow: {
    color: "#f59e0b",
    textTransform: "uppercase",
    letterSpacing: 1.2,
    fontSize: 12,
    fontWeight: "700"
  },
  title: {
    color: "#f8fafc",
    fontSize: 30,
    fontWeight: "800",
    flexShrink: 1
  },
  addCarIconButton: {
    width: 46,
    height: 46,
    borderRadius: 14,
    backgroundColor: "#f59e0b",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
    borderColor: "#fbbf24"
  },
  subtitle: {
    color: "#cbd5e1",
    fontSize: 15,
    lineHeight: 22
  },
  section: {
    backgroundColor: "#111827",
    borderRadius: 20,
    padding: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: "#1f2937"
  },
  garageList: {
    backgroundColor: "#111827",
    borderRadius: 20,
    padding: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: "#1f2937"
  },
  sectionTitle: {
    color: "#f8fafc",
    fontSize: 18,
    fontWeight: "700"
  },
  field: {
    gap: 6
  },
  label: {
    color: "#cbd5e1",
    fontSize: 13,
    fontWeight: "600"
  },
  input: {
    backgroundColor: "#0f172a",
    borderColor: "#334155",
    borderWidth: 1,
    borderRadius: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
    color: "#f8fafc",
    fontSize: 16
  },
  primaryButton: {
    backgroundColor: "#f59e0b",
    paddingVertical: 14,
    borderRadius: 14,
    alignItems: "center"
  },
  primaryButtonText: {
    color: "#111827",
    fontWeight: "800",
    fontSize: 15
  },
  emptyState: {
    color: "#94a3b8",
    lineHeight: 22
  },
  carCard: {
    backgroundColor: "#0f172a",
    borderRadius: 18,
    padding: 14,
    gap: 14,
    borderWidth: 1,
    borderColor: "#1e293b"
  },
  cardHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
    gap: 12
  },
  regHeaderRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12
  },
  regPlate: {
    color: "#111827",
    backgroundColor: "#facc15",
    alignSelf: "flex-start",
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: 8,
    fontSize: 20,
    fontWeight: "900",
    letterSpacing: 1
  },
  cardMeta: {
    color: "#cbd5e1",
    marginTop: 8
  },
  refreshIconButton: {
    width: 38,
    height: 38,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent",
    marginTop: 2
  },
  refreshIconSpin: {
    width: 30,
    height: 30,
    alignItems: "center",
    justifyContent: "center"
  },
  iconButton: {
    width: 40,
    height: 40,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: "transparent"
  },
  detailGrid: {
    gap: 10
  },
  detailRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: 12,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
    paddingBottom: 8
  },
  detailLabel: {
    color: "#94a3b8",
    fontSize: 13
  },
  detailValue: {
    color: "#f8fafc",
    fontSize: 13,
    fontWeight: "600",
    flexShrink: 1,
    textAlign: "right"
  },
  notSetValue: {
    color: "#ef4444"
  },
  updatedText: {
    color: "#64748b",
    fontSize: 12
  },
  helperText: {
    color: "#94a3b8",
    fontSize: 13
  },
  toggleRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: 10
  },
  toggleLabel: {
    color: "#cbd5e1",
    fontSize: 14,
    flexShrink: 0
  },
  toggleControls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 8
  },
  reminderOffsetControl: {
    flexDirection: "row",
    width: 116,
    height: 30,
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 9,
    overflow: "hidden",
    backgroundColor: "#0f172a"
  },
  reminderOffsetSegment: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    position: "relative"
  },
  reminderOffsetSegmentSelected: {
    backgroundColor: "#f59e0b"
  },
  reminderOffsetText: {
    color: "#e5e7eb",
    fontWeight: "800",
    fontSize: 12
  },
  reminderOffsetTextSelected: {
    color: "#111827"
  },
  reminderOffsetDivider: {
    position: "absolute",
    right: 0,
    top: 5,
    bottom: 5,
    width: 1,
    backgroundColor: "#334155"
  },
  cardActions: {
    flexDirection: "row",
    gap: 10
  },
  secondaryButton: {
    flex: 1,
    backgroundColor: "#1d4ed8",
    paddingVertical: 12,
    borderRadius: 12,
    alignItems: "center"
  },
  secondaryButtonText: {
    color: "#eff6ff",
    fontWeight: "700"
  },
  ghostButton: {
    paddingHorizontal: 16,
    justifyContent: "center",
    borderRadius: 12,
    borderWidth: 1,
    borderColor: "#334155"
  },
  ghostButtonText: {
    color: "#cbd5e1",
    fontWeight: "700"
  },
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(11,18,32,0.72)",
    alignItems: "center",
    justifyContent: "center",
    padding: 20
  },
  modalCard: {
    width: "100%",
    maxWidth: 380,
    backgroundColor: "#111827",
    borderRadius: 18,
    padding: 16,
    gap: 14,
    borderWidth: 1,
    borderColor: "#1f2937"
  }
});

export default App;
