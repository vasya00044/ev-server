import BillingIntegration from './BillingIntegration';
import { BillingSettingsType } from '../../types/Setting';
import Logging from '../../utils/Logging';
import { ServerAction } from '../../types/Server';
import SettingStorage from '../../storage/mongodb/SettingStorage';
import StripeBillingIntegration from './stripe/StripeBillingIntegration';
import Tenant from '../../types/Tenant';
import TenantComponents from '../../types/TenantComponents';
import TenantStorage from '../../storage/mongodb/TenantStorage';
import Utils from '../../utils/Utils';

const MODULE_NAME = 'BillingFactory';

export default class BillingFactory {
  static async getBillingImpl(tenantID: string): Promise<BillingIntegration> {
    // Get the tenant
    const tenant: Tenant = await TenantStorage.getTenant(tenantID);
    // Check if billing is active
    if (Utils.isTenantComponentActive(tenant, TenantComponents.PRICING) &&
        Utils.isTenantComponentActive(tenant, TenantComponents.BILLING)) {
      // Get the billing's settings
      const settings = await SettingStorage.getBillingSetting(tenantID);
      if (settings) {
        let billingIntegrationImpl = null;
        switch (settings.type) {
          case BillingSettingsType.STRIPE:
            billingIntegrationImpl = StripeBillingIntegration.getInstance(tenantID, settings);
            break;
        }
        return billingIntegrationImpl;
      }
      await Logging.logDebug({
        tenantID: tenant.id,
        action: ServerAction.BILLING,
        module: MODULE_NAME, method: 'getBillingImpl',
        message: 'Billing settings are not configured'
      });
    }
    return null;
  }
}
