package constraints.generated;

import constraints.procedures.MinBatterySOC;
import constraints.procedures.OnboardStorageFull;
import gov.nasa.ammos.plandev.contrib.serialization.mappers.RecordValueMapper;
import gov.nasa.ammos.plandev.merlin.framework.ValueMapper;
import java.util.List;
import javax.annotation.processing.Generated;

@Generated("gov.nasa.ammos.plandev.procedural.processor.ProcedureProcessor")
@SuppressWarnings("unchecked")
public final class AutoValueMappers {
  public static ValueMapper<MinBatterySOC> constraints_procedures_MinBatterySOC(
      final ValueMapper<Double> minSOC_ValueMapper) {
    return new RecordValueMapper<>(
      MinBatterySOC.class,
      List.of(
        new RecordValueMapper.Component<>(
          "minSOC",
          MinBatterySOC::minSOC,
          minSOC_ValueMapper)));
  }

  public static ValueMapper<OnboardStorageFull> constraints_procedures_OnboardStorageFull(
      final ValueMapper<Double> fractionFull_ValueMapper) {
    return new RecordValueMapper<>(
      OnboardStorageFull.class,
      List.of(
        new RecordValueMapper.Component<>(
          "fractionFull",
          OnboardStorageFull::fractionFull,
          fractionFull_ValueMapper)));
  }
}
